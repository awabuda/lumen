/**
 * `read_file` — read a text file with line numbers and pagination.
 *
 * The output content is the requested slice of the file with each line
 * prefixed by a fixed-width line number and a `|` separator, matching
 * the format used by the canonical `cat -n` convention:
 *
 * ```
 *     1|first line
 *     2|second line
 * ```
 *
 * Use `offset` and `limit` to page through very large files. The total
 * line count of the underlying file is always returned so the caller can
 * implement "next page" logic without re-reading.
 */
import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core';
/** Zod schema for the tool's input. */
export declare const ReadFileInputSchema: z.ZodObject<{
    /** File path, resolved against `ctx.cwd` if relative. */
    path: z.ZodString;
    /** 1-indexed starting line. Defaults to 1. Must be >= 1. */
    offset: z.ZodOptional<z.ZodNumber>;
    /** Maximum number of lines to return. Defaults to 500. Must be >= 1. */
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    path: string;
    offset?: number | undefined;
    limit?: number | undefined;
}, {
    path: string;
    offset?: number | undefined;
    limit?: number | undefined;
}>;
export type ReadFileInput = z.infer<typeof ReadFileInputSchema>;
/** Zod schema for the tool's output. */
export declare const ReadFileOutputSchema: z.ZodObject<{
    /** File content with line numbers prepended (e.g. `"   42|code"`). */
    content: z.ZodString;
    /** Total number of lines in the file (independent of pagination). */
    totalLines: z.ZodNumber;
    /** Encoding used to decode the file. */
    encoding: z.ZodLiteral<"utf8">;
}, "strip", z.ZodTypeAny, {
    encoding: "utf8";
    content: string;
    totalLines: number;
}, {
    encoding: "utf8";
    content: string;
    totalLines: number;
}>;
export type ReadFileOutput = z.infer<typeof ReadFileOutputSchema>;
/**
 * Tool: read a text file with line numbers.
 *
 * Input is validated by {@link ReadFileInputSchema}; output is validated
 * by the schema embedded in {@link BaseTool.describe} and matches
 * {@link ReadFileOutput}.
 */
export declare class ReadFileTool extends BaseTool {
    readonly name = "read_file";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: ToolRisk;
    readonly version = "0.1.0";
    protected execute(input: unknown, ctx: ToolContext): Promise<ReadFileOutput>;
}
//# sourceMappingURL=read-file.d.ts.map