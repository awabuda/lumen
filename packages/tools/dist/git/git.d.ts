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
import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core';
/** Single argv item. We accept only what the schema whitelists. */
declare const GitOpSchema: z.ZodEnum<["status", "diff", "log", "branch", "commit"]>;
export type GitOp = z.infer<typeof GitOpSchema>;
/** Zod schema for the tool's input. */
export declare const GitInputSchema: z.ZodEffects<z.ZodObject<{
    /** Which git operation to run. */
    op: z.ZodEnum<["status", "diff", "log", "branch", "commit"]>;
    /** Optional revision / ref (e.g. `HEAD~1`, `main`, `feature/x`). */
    ref: z.ZodOptional<z.ZodString>;
    /** Optional second ref for `diff` (e.g. `main..feature`). */
    ref2: z.ZodOptional<z.ZodString>;
    /**
     * For `log` only: cap the number of commits returned.
     * Defaults to 20. Hard-capped at 500 so a malicious
     * "show me everything" prompt doesn't OOM the agent.
     */
    maxCount: z.ZodOptional<z.ZodNumber>;
    /** For `log` and `diff` only: cap bytes of output. Defaults to 256 KiB. */
    maxBytes: z.ZodOptional<z.ZodNumber>;
    /**
     * For `commit` only: the commit message. Conventional-commits
     * subject line max 72 chars; we don't enforce a style, we
     * just reject empties.
     */
    message: z.ZodOptional<z.ZodString>;
    /**
     * For `commit` only: also stage modified-tracked files
     * before committing. Defaults to false — we do not want
     * to surprise the user with a commit that includes
     * half-finished edits.
     */
    stageAll: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    op: "status" | "diff" | "log" | "branch" | "commit";
    ref?: string | undefined;
    ref2?: string | undefined;
    maxCount?: number | undefined;
    maxBytes?: number | undefined;
    message?: string | undefined;
    stageAll?: boolean | undefined;
}, {
    op: "status" | "diff" | "log" | "branch" | "commit";
    ref?: string | undefined;
    ref2?: string | undefined;
    maxCount?: number | undefined;
    maxBytes?: number | undefined;
    message?: string | undefined;
    stageAll?: boolean | undefined;
}>, {
    op: "status" | "diff" | "log" | "branch" | "commit";
    ref?: string | undefined;
    ref2?: string | undefined;
    maxCount?: number | undefined;
    maxBytes?: number | undefined;
    message?: string | undefined;
    stageAll?: boolean | undefined;
}, {
    op: "status" | "diff" | "log" | "branch" | "commit";
    ref?: string | undefined;
    ref2?: string | undefined;
    maxCount?: number | undefined;
    maxBytes?: number | undefined;
    message?: string | undefined;
    stageAll?: boolean | undefined;
}>;
export type GitInput = z.infer<typeof GitInputSchema>;
/** Zod schema for the tool's output. */
export declare const GitOutputSchema: z.ZodObject<{
    op: z.ZodEnum<["status", "diff", "log", "branch", "commit"]>;
    /** Operation-specific structured data. */
    data: z.ZodUnknown;
    /** Raw combined stdout+stderr, capped. Useful for the agent to see what `git` actually said. */
    raw: z.ZodString;
    exitCode: z.ZodNullable<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    op: "status" | "diff" | "log" | "branch" | "commit";
    raw: string;
    exitCode: number | null;
    data?: unknown;
}, {
    op: "status" | "diff" | "log" | "branch" | "commit";
    raw: string;
    exitCode: number | null;
    data?: unknown;
}>;
export type GitOutput = z.infer<typeof GitOutputSchema>;
/**
 * The `git` tool.
 *
 * All operations are implemented as **read-only children
 * (`git status`, `git log`, `git diff`, `git branch`)** or
 * one specifically audited writer (`git commit`). The writer
 * is `approval-required`; the readers are `safe`. There is
 * no `git push`, no `git reset --hard`, no `git clean`.
 */
export declare class GitTool extends BaseTool {
    readonly name = "git";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: ToolRisk;
    readonly version = "0.1.0";
    /**
     * Maximum bytes the tool will buffer from a single git invocation.
     * Beyond this, the child is killed and the partial output returned
     * with a `truncated` hint in `data`.
     */
    readonly maxOutputBytes: number;
    protected execute(input: unknown, ctx: ToolContext): Promise<GitOutput>;
    /**
     * Build the argv for the chosen operation. Each branch is
     * explicit; adding a new op means adding a branch here and
     * the type system reminds you.
     */
    private argvFor;
    /**
     * Hook for derived classes to override the argv layout (e.g. to
     * inject `git -C <dir>`). The base implementation just prepends
     * `git`. Returns `{ execArgv, cwd }` so a derived class can also
     * relocate the working directory.
     */
    protected spawnGit(argv: string[], cwd: string): {
        execArgv: string[];
        cwd: string;
    };
    /**
     * Parse the porcelain output into structured data per op.
     * Each branch returns a small, typed record; the LLM gets
     * a JSON it can reason about instead of a string it has
     * to re-parse.
     */
    private parseOutput;
}
export {};
//# sourceMappingURL=git.d.ts.map