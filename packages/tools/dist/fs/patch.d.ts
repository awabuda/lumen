/**
 * `patch` — find-and-replace in a file, with fuzzy whitespace tolerance.
 *
 * The match is performed in two passes:
 *   1. Exact substring match. If it appears exactly once (or the caller
 *      set `replaceAll: true`), use it directly.
 *   2. Whitespace-normalized match: collapse runs of whitespace
 *      (including newlines) to a single space, then search. This
 *      tolerates trivial indentation differences.
 *
 * Patches always use the atomic writer from {@link WriteFileTool}, so
 * a half-applied patch is never observed.
 */
import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolDescriptor } from '@lumen/core';
/** Zod schema for the tool's input. */
export declare const PatchInputSchema: z.ZodObject<{
    /** File path, resolved against `ctx.cwd` if relative. */
    path: z.ZodString;
    /** The exact substring to find. Must be at least 1 character. */
    oldString: z.ZodString;
    /** The replacement. May be empty (deletion). */
    newString: z.ZodString;
    /** When true, replace every occurrence. Defaults to false (unique match). */
    replaceAll: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean | undefined;
}, {
    path: string;
    oldString: string;
    newString: string;
    replaceAll?: boolean | undefined;
}>;
export type PatchInput = z.infer<typeof PatchInputSchema>;
/** Zod schema for the tool's output. */
export declare const PatchOutputSchema: z.ZodObject<{
    /** Number of replacements actually performed. */
    replacements: z.ZodNumber;
    /** Absolute path of the patched file. */
    path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
    replacements: number;
}, {
    path: string;
    replacements: number;
}>;
export type PatchOutput = z.infer<typeof PatchOutputSchema>;
/** Tool: find-and-replace in a file with fuzzy whitespace matching. */
export declare class PatchTool extends BaseTool {
    readonly name = "patch";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: "approval-required";
    readonly version = "0.1.0";
    protected execute(input: unknown, ctx: ToolContext): Promise<PatchOutput>;
    describe(): ToolDescriptor;
}
//# sourceMappingURL=patch.d.ts.map