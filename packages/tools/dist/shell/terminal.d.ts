import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core';
import { type ShellSandboxConfig } from './sandbox.js';
/** Zod schema for the tool's input. */
export declare const TerminalInputSchema: z.ZodObject<{
    /**
     * Argv to execute. Must be a non-empty array; the first element
     * is the program, the rest are arguments. No shell interpretation.
     */
    command: z.ZodArray<z.ZodString, "many">;
    /** Optional working directory. Resolved against `ctx.cwd` if relative. */
    cwd: z.ZodOptional<z.ZodString>;
    /**
     * Optional environment variables to set on the child. Each key
     * must match the env-var regex; we refuse to pass through keys
     * that look like an injection vector (`FOO;rm`).
     */
    env: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    /**
     * Per-call timeout override in milliseconds. If absent, the
     * sandbox's configured `timeoutMs` is used. Clamped to a sane
     * upper bound so a typo (`timeoutMs: 99999999`) doesn't hang
     * the agent for a day.
     */
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    command: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
}, {
    command: string[];
    cwd?: string | undefined;
    env?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
}>;
export type TerminalInput = z.infer<typeof TerminalInputSchema>;
/** Zod schema for the tool's output. */
export declare const TerminalOutputSchema: z.ZodObject<{
    exitCode: z.ZodNullable<z.ZodNumber>;
    signal: z.ZodNullable<z.ZodString>;
    stdout: z.ZodString;
    stderr: z.ZodString;
    durationMs: z.ZodNumber;
    truncated: z.ZodBoolean;
    /** Empty when the command ran; populated when the sandbox refused. */
    refusal: z.ZodNullable<z.ZodObject<{
        reason: z.ZodEnum<["policy-disabled", "policy-violation", "budget-exhausted"]>;
        message: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        message: string;
        reason: "policy-disabled" | "policy-violation" | "budget-exhausted";
    }, {
        message: string;
        reason: "policy-disabled" | "policy-violation" | "budget-exhausted";
    }>>;
}, "strip", z.ZodTypeAny, {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    truncated: boolean;
    refusal: {
        message: string;
        reason: "policy-disabled" | "policy-violation" | "budget-exhausted";
    } | null;
}, {
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    truncated: boolean;
    refusal: {
        message: string;
        reason: "policy-disabled" | "policy-violation" | "budget-exhausted";
    } | null;
}>;
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>;
/**
 * The `terminal` tool.
 *
 * The sandbox is **injected** via the constructor rather than
 * resolved per-call. That's an explicit choice: it lets the
 * composition root freeze the sandbox at startup, and it lets
 * tests swap a `FakeSandbox` without touching the registry.
 */
export declare class TerminalTool extends BaseTool {
    readonly name = "terminal";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: ToolRisk;
    readonly version = "0.1.0";
    private readonly sandbox;
    /**
     * @param sandboxConfig The sandbox config. If absent, the default
     *   `default` strategy is used. The tool does **not** mutate
     *   the config — it stores the resolved sandbox for the lifetime
     *   of the tool.
     */
    constructor(sandboxConfig?: ShellSandboxConfig);
    protected execute(input: unknown, ctx: ToolContext): Promise<TerminalOutput>;
    /**
     * Pull the configured timeout from the sandbox at execution time
     * so an operator can change it between agent runs without
     * recreating the tool. Default 30s.
     */
    private sandboxTimeoutMs;
}
//# sourceMappingURL=terminal.d.ts.map