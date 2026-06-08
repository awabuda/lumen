/**
 * `write_file` — write text to a file, optionally atomically.
 *
 * Atomic mode (the default) writes to `<path>.tmp` and then renames the
 * temporary file over the target. This guarantees that concurrent
 * readers see either the previous contents or the new contents — never
 * a half-written file. The temporary file is cleaned up on failure.
 *
 * Non-atomic mode writes directly via `fs.writeFile` (faster, useful
 * for non-critical files like caches).
 */
import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolDescriptor } from '@lumen/core';
/** Zod schema for the tool's input. */
export declare const WriteFileInputSchema: z.ZodObject<{
    /** File path, resolved against `ctx.cwd` if relative. */
    path: z.ZodString;
    /** UTF-8 content to write. Empty string is allowed. */
    content: z.ZodString;
    /** When true (default), write to a `.tmp` file and rename. */
    atomic: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    path: string;
    content: string;
    atomic?: boolean | undefined;
}, {
    path: string;
    content: string;
    atomic?: boolean | undefined;
}>;
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>;
/** Zod schema for the tool's output. */
export declare const WriteFileOutputSchema: z.ZodObject<{
    /** Number of bytes written (UTF-8 byte length of `content`). */
    bytesWritten: z.ZodNumber;
    /** Absolute path that was written. */
    path: z.ZodString;
}, "strip", z.ZodTypeAny, {
    path: string;
    bytesWritten: number;
}, {
    path: string;
    bytesWritten: number;
}>;
export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>;
/**
 * Write a file atomically: write to `<path>.tmp`, then rename over the
 * target. Cleans up the temp file on failure. Returns the number of
 * bytes written.
 *
 * Exported for use by {@link PatchTool}, which also needs atomic writes.
 */
export declare function atomicWriteFile(absPath: string, content: string, signal: AbortSignal): Promise<number>;
/** Tool: write a file, with an optional atomic mode. */
export declare class WriteFileTool extends BaseTool {
    readonly name = "write_file";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: "dangerous";
    readonly version = "0.1.0";
    protected execute(input: unknown, ctx: ToolContext): Promise<WriteFileOutput>;
    describe(): ToolDescriptor;
}
//# sourceMappingURL=write-file.d.ts.map