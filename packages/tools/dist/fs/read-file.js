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
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BaseTool } from '@lumen/core';
import { FileNotFoundError } from '../errors.js';
/** Zod schema for the tool's input. */
export const ReadFileInputSchema = z.object({
    /** File path, resolved against `ctx.cwd` if relative. */
    path: z.string().min(1),
    /** 1-indexed starting line. Defaults to 1. Must be >= 1. */
    offset: z.number().int().min(1).optional(),
    /** Maximum number of lines to return. Defaults to 500. Must be >= 1. */
    limit: z.number().int().min(1).optional(),
});
/** Zod schema for the tool's output. */
export const ReadFileOutputSchema = z.object({
    /** File content with line numbers prepended (e.g. `"   42|code"`). */
    content: z.string(),
    /** Total number of lines in the file (independent of pagination). */
    totalLines: z.number().int().min(0),
    /** Encoding used to decode the file. */
    encoding: z.literal('utf8'),
});
/** Default page size if `limit` is not provided. */
const DEFAULT_LIMIT = 500;
/** Width of the line-number gutter in characters. */
const GUTTER_WIDTH = 6;
/**
 * Tool: read a text file with line numbers.
 *
 * Input is validated by {@link ReadFileInputSchema}; output is validated
 * by the schema embedded in {@link BaseTool.describe} and matches
 * {@link ReadFileOutput}.
 */
export class ReadFileTool extends BaseTool {
    name = 'read_file';
    description = 'Read a text file. Returns content with line numbers (e.g. "   42|code") and the total line count. ' +
        'Use offset+limit to page through large files. Resolves relative paths against the working directory.';
    inputSchema = ReadFileInputSchema;
    risk = 'safe';
    version = '0.1.0';
    async execute(input, ctx) {
        const { path: userPath, offset, limit } = input;
        const absPath = path.resolve(ctx.cwd, userPath);
        const startLine = offset ?? 1;
        const maxLines = limit ?? DEFAULT_LIMIT;
        let raw;
        try {
            raw = await fs.readFile(absPath, 'utf8');
        }
        catch (err) {
            const e = err;
            if (e.code === 'ENOENT') {
                throw new FileNotFoundError(absPath, err);
            }
            throw err;
        }
        const allLines = raw.split('\n');
        // If the file ended with a newline, the trailing element is empty —
        // drop it so the line count matches what users expect. A 0-byte file
        // has 0 lines; "a\n" has 1; "a\nb" has 2.
        if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
            allLines.pop();
        }
        const totalLines = allLines.length;
        const endLine = Math.min(startLine - 1 + maxLines, allLines.length);
        const slice = allLines.slice(startLine - 1, endLine);
        const numbered = slice
            .map((line, idx) => {
            const lineNo = startLine + idx;
            const gutter = String(lineNo).padStart(GUTTER_WIDTH, ' ');
            return `${gutter}|${line}`;
        })
            .join('\n');
        const output = {
            content: numbered,
            totalLines,
            encoding: 'utf8',
        };
        return output;
    }
}
//# sourceMappingURL=read-file.js.map