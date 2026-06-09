/**
 * `ShellSandbox` — pluggable execution boundary for the `terminal` tool.
 *
 * The sandbox is a **strategy**: it decides how a command is spawned, what
 * working directory it sees, what environment it inherits, and what
 * happens on timeout / cancellation. The `terminal` tool delegates every
 * one of those concerns to the sandbox so the tool itself stays a thin
 * argument-validator.
 *
 * Why a strategy instead of inlining `child_process.spawn` in the tool?
 *   - The same `terminal` tool can run on macOS, inside a Linux container,
 *     or inside a Docker-in-Docker CI runner without code changes.
 *   - Tests inject a `FakeSandbox` to capture and assert on command shape
 *     without spawning real processes.
 *   - Operators can replace the strategy at startup ("use a sandbox
 *     built on bubblewrap" or "use a Docker container with no network")
 *     via {@link ShellSandboxConfig.strategy}, not by forking the tool.
 *
 * The three shipped strategies:
 *
 *   - {@link DefaultSandbox} — direct `child_process.spawn` on the host
 *     with the configured `cwd`, `env`, and `timeout`. No isolation beyond
 *     what the OS already provides.
 *   - {@link NoneSandbox} — refuse every command. Used when an operator
 *     wants the agent to ship without a working shell (e.g. production
 *     gateway where shell access is forbidden by policy).
 *   - The strategy contract is intentionally narrow so a future
 *     `DockerSandbox` / `BubblewrapSandbox` / `FirejailSandbox` can be
 *     added without touching the `terminal` tool.
 *
 * The sandbox is **stateless** beyond the immutable config passed at
 * construction; calling `run()` is safe from multiple concurrent tools.
 */
import type { ChildProcess } from 'node:child_process';
/**
 * Per-invocation sandbox input.
 *
 * - `command` is the exact argv the agent asked to run. Sandbox strategies
 *   MUST spawn this argv verbatim — the `terminal` tool has already
 *   refused to handle shell metacharacters via
 *   {@link ShellCommandSchema}.
 * - `cwd` is the directory the command should see as its current
 *   working directory. The default sandbox honours it; isolated sandboxes
 *   may chroot or `pivot_root` over it.
 * - `env` is the env the agent wants to set on top of the inherited
 *   environment. Implementations MUST NOT pass through `PATH` from the
 *   host environment blindly; merge with the operator-supplied
 *   {@link ShellSandboxConfig.env} instead.
 * - `timeoutMs` is the wall-clock budget. A sandbox that ignores it is
 *   a sandbox that will hang agents on a runaway `find /`.
 * - `signal` is the agent's abort signal. The sandbox MUST wire it to
 *   the child process so a Ctrl+C from the user tears down the command.
 */
export interface ShellSandboxRequest {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
}
/**
 * Per-invocation sandbox result. Mirrors the shape of `child_process`
 * spawn results but with `Buffer`s decoded to strings, because the agent
 * almost never benefits from raw bytes for shell output.
 */
export interface ShellSandboxResult {
    /** Process exit code, or `null` if the process was killed by a signal. */
    readonly exitCode: number | null;
    /** Signal that killed the process, if any. */
    readonly signal: NodeJS.Signals | null;
    /** Decoded stdout. Truncated to {@link ShellSandboxConfig.maxOutputBytes} if needed. */
    readonly stdout: string;
    /** Decoded stderr. Same truncation rules as `stdout`. */
    readonly stderr: string;
    /** Wall-clock duration in milliseconds. */
    readonly durationMs: number;
    /** True when the output was truncated. */
    readonly truncated: boolean;
}
/**
 * Reason for a hard refusal from the sandbox. Sandboxes do not refuse
 * arbitrarily — they refuse in one of three documented ways, and
 * the agent loop converts each to a different `RunEvent` kind.
 */
export type ShellSandboxRefusalReason = 
/** Strategy is `none`; the agent is not allowed to run commands at all. */
'policy-disabled'
/** Command failed a pre-flight policy check (e.g. `rm -rf /`). */
 | 'policy-violation'
/** Resource budget exhausted (timeout, max-output, etc.). */
 | 'budget-exhausted';
/** Outcome of a `run` call. Either a result or a typed refusal. */
export type ShellSandboxOutcome = {
    readonly kind: 'ok';
    readonly result: ShellSandboxResult;
} | {
    readonly kind: 'refused';
    readonly reason: ShellSandboxRefusalReason;
    readonly message: string;
};
/**
 * Static factory for {@link ShellSandbox} instances.
 *
 * The factory pattern keeps the `terminal` tool from needing an `if`
 * cascade over strategy names and keeps test code free of dynamic
 * `import()` calls.
 */
export type ShellSandboxFactory = (config: ShellSandboxConfig) => ShellSandbox;
/**
 * Strategy interface.
 *
 * The shape is deliberately small. If a future strategy needs
 * "streamed output" or "pty", that is a new optional method on a new
 * interface — the existing `run` contract stays the same.
 */
export interface ShellSandbox {
    /**
     * Spawn the command and resolve with its outcome.
     *
     * Implementations MUST honour the abort signal. If the signal fires
     * before the child exits, the implementation kills the child, waits
     * for the OS to reap it, and resolves with `kind: 'ok'` and a
     * synthetic `ShellSandboxResult` whose `signal` is set. The
     * `terminal` tool then surfaces that as a "user interrupted"
     * message in the agent loop.
     */
    run(request: ShellSandboxRequest): Promise<ShellSandboxOutcome>;
}
/**
 * Configuration for a {@link ShellSandbox} instance.
 *
 * Held immutable by the default sandbox; advanced strategies
 * (Docker, etc.) may capture more fields without changing this
 * shape.
 */
export interface ShellSandboxConfig {
    /**
     * Strategy name. `default` and `none` ship in this package;
     * additional names are resolved via the `factories` map so
     * downstream packages can register their own without forking.
     */
    readonly strategy: 'default' | 'none' | (string & {});
    /**
     * Extra environment variables to expose to the child, on top of
     * the curated allowlist the default sandbox applies. Keys here
     * override the default.
     */
    readonly env: Readonly<Record<string, string>>;
    /**
     * Hard wall-clock cap in milliseconds. The default sandbox
     * applies it via `AbortSignal.timeout`; isolated sandboxes may
     * apply it at the container level.
     */
    readonly timeoutMs: number;
    /**
     * Maximum bytes captured from each of stdout/stderr before the
     * child is killed and `truncated: true` is set on the result.
     * Prevents `cat /dev/zero` from OOMing the agent.
     */
    readonly maxOutputBytes: number;
    /**
     * Map of strategy-name → factory. The CLI composition root
     * registers `default` and `none`; downstream packages
     * (e.g. a `lumen-tools-docker` plugin) can register `docker`.
     */
    readonly factories: Readonly<Record<string, ShellSandboxFactory>>;
}
/**
 * Resolve a sandbox from a config.
 *
 * Throws a typed error if the strategy name is unknown. We do not
 * silently fall back to `default` because an operator who asked
 * for `docker` and got `default` would have a worse day than
 * someone who got a clear error.
 */
export declare function resolveSandbox(config: ShellSandboxConfig): ShellSandbox;
/**
 * Helper: capture a child process's `exit` and `error` events into the
 * sandbox result shape. Used by {@link DefaultSandbox} and any future
 * strategy that uses `child_process.spawn` under the hood.
 */
export declare function awaitChild(child: ChildProcess, signal: AbortSignal): Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}>;
//# sourceMappingURL=sandbox.d.ts.map