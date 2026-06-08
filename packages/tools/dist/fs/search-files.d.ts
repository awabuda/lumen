/**
 * `search_files` — regex content search across a directory tree.
 *
 * Strategy:
 *   1. Try to invoke `rg --json` (ripgrep). If the binary is on PATH
 *      and the call succeeds, parse its JSON-line output.
 *   2. Otherwise, fall back to a pure-Node recursive walk that
 *      applies the same regex to each line of each matching file.
 *
 * The fallback is not a full replacement for ripgrep (no `.gitignore`
 * awareness, no binary-file skip beyond extension, no parallelism
 * tuning) but it produces identical results for the shapes this tool
 * documents and is correct for the common case.
 */
import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolDescriptor } from '@lumen/core';
/** Zod schema for the tool's input. */
export declare const SearchFilesInputSchema: z.ZodObject<{
    /** Regular expression source (ECMAScript syntax). */
    pattern: z.ZodString;
    /** Directory to search in, resolved against `ctx.cwd` if relative. */
    path: z.ZodString;
    /** Glob to filter files. Defaults to `*` (match every file). */
    glob: z.ZodOptional<z.ZodString>;
    /** Cap on the number of matches returned. Defaults to 100. */
    maxResults: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    path: string;
    pattern: string;
    glob?: string | undefined;
    maxResults?: number | undefined;
}, {
    path: string;
    pattern: string;
    glob?: string | undefined;
    maxResults?: number | undefined;
}>;
export type SearchFilesInput = z.infer<typeof SearchFilesInputSchema>;
/** One match in a search result. */
export interface SearchMatch {
    /** Absolute path of the file containing the match. */
    file: string;
    /** 1-indexed line number of the match. */
    line: number;
    /** The matched line, with trailing newline stripped. */
    content: string;
}
/** Zod schema for the tool's output. */
export declare const SearchFilesOutputSchema: z.ZodObject<{
    matches: z.ZodArray<z.ZodObject<{
        file: z.ZodString;
        line: z.ZodNumber;
        content: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        content: string;
        file: string;
        line: number;
    }, {
        content: string;
        file: string;
        line: number;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    matches: {
        content: string;
        file: string;
        line: number;
    }[];
}, {
    matches: {
        content: string;
        file: string;
        line: number;
    }[];
}>;
export type SearchFilesOutput = z.infer<typeof SearchFilesOutputSchema>;
/** Tool: regex content search across a directory tree. */
export declare class SearchFilesTool extends BaseTool {
    readonly name = "search_files";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: "safe";
    readonly version = "0.1.0";
    protected execute(input: unknown, ctx: ToolContext): Promise<SearchFilesOutput>;
    describe(): ToolDescriptor;
}
//# sourceMappingURL=search-files.d.ts.map