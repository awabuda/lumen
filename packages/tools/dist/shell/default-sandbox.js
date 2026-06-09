/**
 * `DefaultSandbox` — direct `child_process.spawn` on the host.
 *
 * This is the "no extra isolation, just structured safety" sandbox.
 * It enforces:
 *
 *   - **Env allowlist.** The child never sees the host's `PATH`,
 *     `LD_*`, or any other variable the operator didn't whitelist.
 *     The agent passes its requested env via the `env` field on the
 *     request; we merge that with the operator config and **drop**
 *     anything in the denylist.
 *   - **Output cap.** `maxOutputBytes` truncates stdout/stderr to
 *     a bound. The child is killed with SIGTERM as soon as either
 *     stream crosses the cap; the result carries `truncated: true`.
 *   - **Wall-clock cap.** `timeoutMs` is wired through
 *     `AbortSignal.timeout`; the child is killed and the result
 *     carries the kill signal.
 *   - **Abort propagation.** The caller-supplied `signal` is
 *     honoured exactly the same way as the timeout signal. From
 *     the child's perspective the two are indistinguishable; the
 *     caller can tell them apart by `durationMs`.
 *
 * What this sandbox does **not** do:
 *   - It does not chroot. The child has the agent's full filesystem
 *     visibility. That is a feature for an LLM that needs to read
 *     `node_modules` and `~/.gitconfig`; it is a security problem
 *     for a multi-tenant gateway. Operators who care about the
 *     latter register a `DockerSandbox` or `BubblewrapSandbox`
 *     strategy.
 *   - It does not block specific commands. The `terminal` tool's
 *     Zod schema refuses shell metacharacters, but `rm -rf build`
 *     is still legal. Operators who want a denylist should layer
 *     one in front of this sandbox (e.g. via a `policy-violation`
 *     pre-check in a derived class).
 */
import { spawn } from 'node:child_process';
import { awaitChild } from './sandbox.js';
/**
 * Environment variable names the default sandbox **always drops**
 * from the inherited host environment, even if the operator didn't
 * say so explicitly. These are the variables that turn a sandbox
 * into "the user just typed the command themselves".
 */
const DANGEROUS_ENV_KEYS = new Set([
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'LD_AUDIT',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_FRAMEWORK_PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONPATH',
    'RUBYOPT',
    'BASH_ENV',
    'ENV',
    'GIT_SSH_COMMAND',
    'GIT_TEMPLATE_DIR',
]);
/** Default env applied when the operator supplies none. */
const BASE_ENV = {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
};
/**
 * Truncate a Buffer to `maxBytes`, decoding as UTF-8 and replacing
 * the tail of any multi-byte character that got sliced in half.
 */
function decodeTruncated(buf, maxBytes) {
    if (buf.length <= maxBytes) {
        return { text: buf.toString('utf8'), truncated: false };
    }
    // Find a safe UTF-8 boundary at or below maxBytes. The high bit
    // pattern tells us the start of a multi-byte sequence.
    let end = maxBytes;
    while (end > 0 && (buf[end] & 0b1100_0000) === 0b1000_0000) {
        end--;
    }
    return {
        text: buf.subarray(0, end).toString('utf8') + '\n[... output truncated ...]\n',
        truncated: true,
    };
}
export class DefaultSandbox {
    env;
    timeoutMs;
    maxOutputBytes;
    constructor(config) {
        this.timeoutMs = config.timeoutMs;
        this.maxOutputBytes = config.maxOutputBytes;
        this.env = mergeEnv(BASE_ENV, config.env);
    }
    run(request) {
        const started = Date.now();
        // Combine the caller's signal with our internal timeout. Whichever
        // fires first kills the child. We hand the merged signal to
        // awaitChild so its `abort` listener still triggers a kill.
        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => timeoutController.abort(), this.timeoutMs);
        const mergedSignal = mergeSignals(request.signal, timeoutController.signal);
        // argv mode: no shell, no metacharacter interpretation. The
        // `terminal` tool's Zod schema already refuses anything that
        // contains a shell metacharacter, so this is belt-and-braces.
        const child = spawn(request.command[0], request.command.slice(1), {
            cwd: request.cwd,
            env: this.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: mergedSignal,
            // Detached: false. We want the child tied to the parent so
            // an agent abort also tears down the whole subprocess tree.
            detached: false,
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutLen = 0;
        let stderrLen = 0;
        let truncated = false;
        const maybeKill = () => {
            if (truncated)
                return;
            truncated = true;
            child.kill('SIGTERM');
        };
        child.stdout?.on('data', (chunk) => {
            stdoutChunks.push(chunk);
            stdoutLen += chunk.length;
            if (stdoutLen > this.maxOutputBytes)
                maybeKill();
        });
        child.stderr?.on('data', (chunk) => {
            stderrChunks.push(chunk);
            stderrLen += chunk.length;
            if (stderrLen > this.maxOutputBytes)
                maybeKill();
        });
        return awaitChild(child, mergedSignal)
            .then(({ exitCode, signal }) => {
            clearTimeout(timeoutHandle);
            const stdout = decodeTruncated(Buffer.concat(stdoutChunks), this.maxOutputBytes);
            const stderr = decodeTruncated(Buffer.concat(stderrChunks), this.maxOutputBytes);
            const result = {
                exitCode,
                signal,
                stdout: stdout.text,
                stderr: stderr.text,
                durationMs: Date.now() - started,
                truncated: stdout.truncated || stderr.truncated || truncated,
            };
            return { kind: 'ok', result };
        })
            .catch((err) => {
            clearTimeout(timeoutHandle);
            // A spawn-time error (ENOENT, EACCES) — the result has
            // exit code 127 by convention.
            const result = {
                exitCode: 127,
                signal: null,
                stdout: '',
                stderr: err instanceof Error ? err.message : String(err),
                durationMs: Date.now() - started,
                truncated: false,
            };
            return { kind: 'ok', result };
        });
    }
}
/**
 * Merge two env maps, dropping any key in the denylist.
 * The right-hand side wins on conflict.
 */
function mergeEnv(base, override) {
    const out = {};
    for (const [k, v] of Object.entries(base)) {
        if (!DANGEROUS_ENV_KEYS.has(k))
            out[k] = v;
    }
    for (const [k, v] of Object.entries(override)) {
        if (!DANGEROUS_ENV_KEYS.has(k))
            out[k] = v;
    }
    return out;
}
/**
 * Wire two abort signals into one. Either firing aborts the merged
 * signal. We use a fresh `AbortController` rather than
 * `AbortSignal.any` because `AbortSignal.any` is Node 20+ and
 * Lumen targets Node 20.10+, but the explicit merge is portable
 * and trivial to test.
 */
function mergeSignals(a, b) {
    if (a.aborted || b.aborted) {
        return AbortSignal.abort();
    }
    const ctrl = new AbortController();
    const onA = () => ctrl.abort(a.reason);
    const onB = () => ctrl.abort(b.reason);
    a.addEventListener('abort', onA, { once: true });
    b.addEventListener('abort', onB, { once: true });
    // Preserve a single reason without leaking listeners — the merged
    // signal's reason is whichever source fired first.
    ctrl.signal.addEventListener('abort', () => {
        a.removeEventListener('abort', onA);
        b.removeEventListener('abort', onB);
    }, { once: true });
    return ctrl.signal;
}
//# sourceMappingURL=default-sandbox.js.map