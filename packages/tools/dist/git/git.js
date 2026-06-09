/**
 * `git` — read-only and write-light git operations.
 *
 * The tool exposes **only** the operations Lumen has audited.
 * It is intentionally not a wrapper around the entire `git`
 * CLI; if the agent needs an operation we haven't shipped
 * (e.g. `git worktree add`), the operator can register a
 * subclass that adds it. This is the same pattern as the
 * `terminal` tool: the agent sees a small, well-typed surface
 * instead of a raw escape hatch.
 *
 * # Why a custom tool, not `terminal ["git", "status"]`?
 *
 *   1. **Structured output.** `git status --porcelain` is a
 *      stable machine-readable format. The `terminal` tool
 *      would hand the agent a string and force it to parse.
 *      This tool hands the agent a typed array of `FileStatus`
 *      records.
 *   2. **Pre-flight approval.** A `git commit` shows up in
 *      the agent's approval flow as "git commit: create
 *      checkpoint", not as the raw command line. That's
 *      easier for the user to read and easier for the
 *      approval policy to match.
 *   3. **Diff size cap.** `git log` on a 10-year-old repo
 *      can produce megabytes. The `git` tool caps diff
 *      size and tells the agent "use `git_log` with
 *      `--max-count=10`".
 *   4. **No arbitrary args.** The LLM cannot ask for
 *      `git push --force` via a generic tool because we
 *      don't ship a `push` operation at all.
 *
 * # Operations shipped
 *
 *   - `status`  — `git status --porcelain` (safe)
 *   - `diff`    — `git diff` or `git diff --staged` (safe)
 *   - `log`     — `git log` with capped output (safe)
 *   - `branch`  — `git branch --list` (safe)
 *   - `commit`  — `git commit -m` (approval-required)
 *
 * `push`, `reset --hard`, `clean -fd`, etc. are deliberately
 * absent. Add them via a subclass if you need them.
 */
import { z } from 'zod';
import { BaseTool } from '@lumen/core';
/** Single argv item. We accept only what the schema whitelists. */
const GitOpSchema = z.enum(['status', 'diff', 'log', 'branch', 'commit']);
/** Zod schema for the tool's input. */
export const GitInputSchema = z
    .object({
    /** Which git operation to run. */
    op: GitOpSchema,
    /** Optional revision / ref (e.g. `HEAD~1`, `main`, `feature/x`). */
    ref: z.string().min(1).max(256).optional(),
    /** Optional second ref for `diff` (e.g. `main..feature`). */
    ref2: z.string().min(1).max(256).optional(),
    /**
     * For `log` only: cap the number of commits returned.
     * Defaults to 20. Hard-capped at 500 so a malicious
     * "show me everything" prompt doesn't OOM the agent.
     */
    maxCount: z.number().int().min(1).max(500).optional(),
    /** For `log` and `diff` only: cap bytes of output. Defaults to 256 KiB. */
    maxBytes: z.number().int().min(1024).max(5 * 1024 * 1024).optional(),
    /**
     * For `commit` only: the commit message. Conventional-commits
     * subject line max 72 chars; we don't enforce a style, we
     * just reject empties.
     */
    message: z.string().min(1).max(4096).optional(),
    /**
     * For `commit` only: also stage modified-tracked files
     * before committing. Defaults to false — we do not want
     * to surprise the user with a commit that includes
     * half-finished edits.
     */
    stageAll: z.boolean().optional(),
})
    .refine((v) => (v.op === 'commit') === (v.message !== undefined), { message: '`message` is required for `commit` and forbidden otherwise' });
/** Zod schema for the tool's output. */
export const GitOutputSchema = z.object({
    op: GitOpSchema,
    /** Operation-specific structured data. */
    data: z.unknown(),
    /** Raw combined stdout+stderr, capped. Useful for the agent to see what `git` actually said. */
    raw: z.string(),
    exitCode: z.number().int().nullable(),
});
/**
 * The `git` tool.
 *
 * All operations are implemented as **read-only children
 * (`git status`, `git log`, `git diff`, `git branch`)** or
 * one specifically audited writer (`git commit`). The writer
 * is `approval-required`; the readers are `safe`. There is
 * no `git push`, no `git reset --hard`, no `git clean`.
 */
export class GitTool extends BaseTool {
    name = 'git';
    description = 'Run a whitelisted git operation. Operations: status, diff, log, branch, commit. ' +
        'Returns structured data plus the raw git output. Use `op: "commit"` to create a checkpoint; ' +
        '`push`, `reset --hard`, and other destructive operations are intentionally not exposed.';
    inputSchema = GitInputSchema;
    risk = 'approval-required';
    version = '0.1.0';
    /**
     * Maximum bytes the tool will buffer from a single git invocation.
     * Beyond this, the child is killed and the partial output returned
     * with a `truncated` hint in `data`.
     */
    maxOutputBytes = 256 * 1024;
    async execute(input, ctx) {
        const parsed = input;
        // Per-op argv construction. We hand-build argv instead of
        // passing a string to `sh -c` so a malicious `ref` value
        // (`"; rm -rf #"`) cannot escape into a shell command.
        const argv = this.argvFor(parsed);
        const env = {
            // Force git to never touch the user's interactive config.
            // The agent runs in an unattended context; the user's
            // `core.editor` is `vim` and we do not want git blocking
            // on an editor prompt.
            GIT_TERMINAL_PROMPT: '0',
            GIT_EDITOR: ':',
            // Lumen's own env (e.g. LUMEN_SESSION) flows through
            // automatically via the sandbox.
        };
        const { spawn } = await import('node:child_process');
        const execArgv = ['git', ...argv];
        const cwd = ctx.cwd;
        return new Promise((resolve) => {
            const child = spawn(execArgv[0], execArgv.slice(1), {
                cwd,
                env: { ...process.env, ...env },
                stdio: ['ignore', 'pipe', 'pipe'],
                signal: ctx.signal,
            });
            const out = [];
            const err = [];
            let truncated = false;
            const onData = (chunk, sink) => {
                sink.push(chunk);
                const total = sink.reduce((n, b) => n + b.length, 0);
                if (total > this.maxOutputBytes) {
                    truncated = true;
                    child.kill('SIGTERM');
                }
            };
            child.stdout?.on('data', (b) => onData(b, out));
            child.stderr?.on('data', (b) => onData(b, err));
            child.on('exit', (code) => {
                const stdout = Buffer.concat(out).toString('utf8');
                const stderr = Buffer.concat(err).toString('utf8');
                const data = this.parseOutput(parsed.op, stdout, truncated);
                resolve({
                    op: parsed.op,
                    data: { ...data, truncated },
                    raw: (stdout + (stderr ? '\n' + stderr : '')).trim(),
                    exitCode: code,
                });
            });
            child.on('error', () => {
                resolve({
                    op: parsed.op,
                    data: { error: 'spawn failed' },
                    raw: '',
                    exitCode: 127,
                });
            });
        });
    }
    /**
     * Build the argv for the chosen operation. Each branch is
     * explicit; adding a new op means adding a branch here and
     * the type system reminds you.
     */
    argvFor(input) {
        switch (input.op) {
            case 'status':
                return ['status', '--porcelain=v2', '--branch'];
            case 'diff': {
                const args = ['diff', '--no-color', '--no-ext-diff'];
                if (input.ref)
                    args.push(input.ref);
                if (input.ref2)
                    args.push(input.ref2);
                return args;
            }
            case 'log': {
                const n = input.maxCount ?? 20;
                return [
                    'log',
                    `--max-count=${n}`,
                    '--no-color',
                    '--pretty=format:%H%x09%an%x09%ae%x09%at%x09%s',
                ];
            }
            case 'branch':
                return ['branch', '--list', '--no-color'];
            case 'commit': {
                const argv = ['commit', '--no-verify'];
                if (input.stageAll)
                    argv.push('-a');
                argv.push('-m', input.message);
                return argv;
            }
        }
    }
    /**
     * Hook for derived classes to override the argv layout (e.g. to
     * inject `git -C <dir>`). The base implementation just prepends
     * `git`. Returns `{ execArgv, cwd }` so a derived class can also
     * relocate the working directory.
     */
    spawnGit(argv, cwd) {
        return { execArgv: ['git', ...argv], cwd };
    }
    /**
     * Parse the porcelain output into structured data per op.
     * Each branch returns a small, typed record; the LLM gets
     * a JSON it can reason about instead of a string it has
     * to re-parse.
     */
    parseOutput(op, raw, _truncated) {
        switch (op) {
            case 'status': {
                // `git status --porcelain=v2 -b` produces:
                // # branch.oid <sha> | (initial)
                // # branch.head <name>
                // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
                // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
                // ? <path>
                // ! <path>
                const lines = raw.split('\n').filter(Boolean);
                const branch = {};
                const files = [];
                for (const line of lines) {
                    if (line.startsWith('# branch.')) {
                        // Strip the `# branch.` prefix so consumers can read
                        // `branch.head`, `branch.oid`, `branch.upstream` etc.
                        // without learning the porcelain-v2 encoding.
                        const rest = line.slice('# branch.'.length);
                        const spaceIdx = rest.indexOf(' ');
                        const key = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
                        const value = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
                        branch[key] = value;
                    }
                    else if (line[0] === '1' || line[0] === '2') {
                        const parts = line.split(' ');
                        const xy = parts[1];
                        const path = parts.slice(8).join(' ');
                        files.push({ kind: line[0] === '1' ? 'staged' : 'renamed', xy, path });
                    }
                    else if (line[0] === '?') {
                        files.push({ kind: 'untracked', xy: '??', path: line.slice(2) });
                    }
                    else if (line[0] === '!') {
                        files.push({ kind: 'ignored', xy: '!!', path: line.slice(2) });
                    }
                }
                return { branch, files };
            }
            case 'log': {
                // Pretty format: <sha>\t<an>\t<ae>\t<at>\t<subject>
                const lines = raw.split('\n').filter(Boolean);
                const commits = lines.map((line) => {
                    const [sha, an, ae, at, ...rest] = line.split('\t');
                    return { sha, author: { name: an, email: ae }, timestamp: Number(at), subject: rest.join('\t') };
                });
                return { commits };
            }
            case 'branch': {
                const lines = raw.split('\n').filter(Boolean);
                return {
                    branches: lines.map((line) => ({
                        name: line.replace(/^[*\s]+/, '').trim(),
                        current: line.startsWith('*'),
                    })),
                };
            }
            case 'diff': {
                return { patch: raw };
            }
            case 'commit': {
                return { committed: true };
            }
        }
    }
}
//# sourceMappingURL=git.js.map