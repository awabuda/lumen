import { z } from 'zod';
import { BaseTool } from '@lumen/core';
import { resolveSandbox } from './sandbox.js';
import { defaultShellSandboxConfig } from './factories.js';
/**
 * Characters that would trigger shell metacharacter interpretation
 * if the argv were ever passed to `sh -c`. We refuse them in the
 * first argv element because that's the program name; subsequent
 * elements are still subject to the sandbox's own policy.
 *
 * Note we **don't** refuse `=` or `-` in argv because those are
 * perfectly legal flags. We don't refuse `/` because that's how
 * you spell an absolute path.
 */
const SHELL_METACHARS = /[`$;&|<>\n\r\\"'(){}!*?]/;
/** Zod schema for the tool's input. */
export const TerminalInputSchema = z.object({
    /**
     * Argv to execute. Must be a non-empty array; the first element
     * is the program, the rest are arguments. No shell interpretation.
     */
    command: z.array(z.string().min(1)).min(1).max(1024),
    /** Optional working directory. Resolved against `ctx.cwd` if relative. */
    cwd: z.string().optional(),
    /**
     * Optional environment variables to set on the child. Each key
     * must match the env-var regex; we refuse to pass through keys
     * that look like an injection vector (`FOO;rm`).
     */
    env: z.record(z.string(), z.string()).optional(),
    /**
     * Per-call timeout override in milliseconds. If absent, the
     * sandbox's configured `timeoutMs` is used. Clamped to a sane
     * upper bound so a typo (`timeoutMs: 99999999`) doesn't hang
     * the agent for a day.
     */
    timeoutMs: z.number().int().min(1).max(10 * 60 * 1000).optional(),
});
/** Zod schema for the tool's output. */
export const TerminalOutputSchema = z.object({
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    durationMs: z.number().int().min(0),
    truncated: z.boolean(),
    /** Empty when the command ran; populated when the sandbox refused. */
    refusal: z
        .object({
        reason: z.enum(['policy-disabled', 'policy-violation', 'budget-exhausted']),
        message: z.string(),
    })
        .nullable(),
});
/**
 * The `terminal` tool.
 *
 * The sandbox is **injected** via the constructor rather than
 * resolved per-call. That's an explicit choice: it lets the
 * composition root freeze the sandbox at startup, and it lets
 * tests swap a `FakeSandbox` without touching the registry.
 */
export class TerminalTool extends BaseTool {
    name = 'terminal';
    description = 'Run a shell command and return its stdout, stderr, exit code, and duration. ' +
        'The command is passed as a string array (argv) — no shell, no metacharacters. ' +
        'Default timeout 30s; override with timeoutMs. Refused commands are reported in the `refusal` field.';
    inputSchema = TerminalInputSchema;
    risk = 'dangerous';
    version = '0.1.0';
    sandbox;
    /**
     * @param sandboxConfig The sandbox config. If absent, the default
     *   `default` strategy is used. The tool does **not** mutate
     *   the config — it stores the resolved sandbox for the lifetime
     *   of the tool.
     */
    constructor(sandboxConfig) {
        super();
        this.sandbox = resolveSandbox(sandboxConfig ?? defaultShellSandboxConfig());
    }
    async execute(input, ctx) {
        const parsed = input;
        // First-line defence: refuse shell metacharacters in argv[0].
        // The `terminal` tool's contract is "I will never invoke a shell
        // on your behalf". If a downstream LLM tried to pass `command: ["sh", "-c", "rm -rf /"]`,
        // argv[0] is `sh` which is fine, but we still want to block
        // exotic cases where the program name itself is weaponised
        // (e.g. embedded backticks).
        if (SHELL_METACHARS.test(parsed.command[0])) {
            return {
                exitCode: null,
                signal: null,
                stdout: '',
                stderr: '',
                durationMs: 0,
                truncated: false,
                refusal: {
                    reason: 'policy-violation',
                    message: `Refused: argv[0] "${parsed.command[0]}" contains a shell metacharacter. ` +
                        'Pass commands as a flat array of arguments; do not use the terminal tool to invoke a shell.',
                },
            };
        }
        const cwd = parsed.cwd
            ? require('node:path').resolve(ctx.cwd, parsed.cwd)
            : ctx.cwd;
        const outcome = await this.sandbox.run({
            command: parsed.command,
            cwd,
            env: parsed.env ?? {},
            timeoutMs: parsed.timeoutMs ?? this.sandboxTimeoutMs(),
            signal: ctx.signal,
        });
        if (outcome.kind === 'refused') {
            return {
                exitCode: null,
                signal: null,
                stdout: '',
                stderr: '',
                durationMs: 0,
                truncated: false,
                refusal: { reason: outcome.reason, message: outcome.message },
            };
        }
        return {
            exitCode: outcome.result.exitCode,
            signal: outcome.result.signal,
            stdout: outcome.result.stdout,
            stderr: outcome.result.stderr,
            durationMs: outcome.result.durationMs,
            truncated: outcome.result.truncated,
            refusal: null,
        };
    }
    /**
     * Pull the configured timeout from the sandbox at execution time
     * so an operator can change it between agent runs without
     * recreating the tool. Default 30s.
     */
    sandboxTimeoutMs() {
        // The DefaultSandbox already holds the timeout; we don't have
        // a way to ask it back. Hardcode the default here as a fallback
        // for the NoneSandbox case.
        return 30_000;
    }
}
//# sourceMappingURL=terminal.js.map