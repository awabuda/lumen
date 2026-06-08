/**
 * `list_dir` — list the entries of a directory, optionally recursively.
 *
 * Recursion is bounded by `maxDepth`: the root is depth 0, immediate
 * children are depth 1, and so on. Entries at `maxDepth` are returned
 * but their children are not descended into. Symlinks are not followed
 * to avoid cycles; they are reported as `other`.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BaseTool } from '@lumen/core';
import { PathKindError } from '../errors.js';
/** Zod schema for the tool's input. */
export const ListDirInputSchema = z.object({
    /** Directory path, resolved against `ctx.cwd` if relative. */
    path: z.string().min(1),
    /** When true, descend into subdirectories up to `maxDepth`. */
    recursive: z.boolean().optional(),
    /** Maximum depth for recursive listing. Defaults to 3. */
    maxDepth: z.number().int().min(0).optional(),
});
/** Zod schema for the tool's output. */
export const ListDirOutputSchema = z.object({
    entries: z.array(z.object({
        name: z.string(),
        type: z.union([z.literal('file'), z.literal('dir'), z.literal('other')]),
        size: z.number().int().min(0).optional(),
    })),
});
/** Default maximum depth if `maxDepth` is not provided. */
const DEFAULT_MAX_DEPTH = 3;
/** Tool: list directory entries, with bounded recursion. */
export class ListDirTool extends BaseTool {
    name = 'list_dir';
    description = 'List entries in a directory. With recursive=true, descends into subdirectories up to maxDepth ' +
        '(default 3). Returns the base name, kind (file/dir/other), and size for files. ' +
        'Does not follow symlinks.';
    inputSchema = ListDirInputSchema;
    risk = 'safe';
    version = '0.1.0';
    async execute(input, ctx) {
        const { path: userPath, recursive, maxDepth } = input;
        const absPath = path.resolve(ctx.cwd, userPath);
        const depthLimit = maxDepth ?? DEFAULT_MAX_DEPTH;
        const entries = [];
        await walk(absPath, absPath, recursive === true, depthLimit, 0, entries, ctx.signal);
        return { entries };
    }
    describe() {
        return { ...super.describe(), version: this.version };
    }
}
/**
 * Walk a directory, populating `out`. `root` is the listing root used to
 * compute the relative `name` field; `current` is the directory being
 * read. Depth is the distance from `root`.
 */
async function walk(root, current, recursive, depthLimit, depth, out, signal) {
    if (signal.aborted)
        throw new Error('aborted');
    const stat = await fs.lstat(current);
    if (!stat.isDirectory()) {
        throw new PathKindError(current, 'dir');
    }
    const dirents = await fs.readdir(current, { withFileTypes: true });
    for (const d of dirents) {
        if (signal.aborted)
            throw new Error('aborted');
        const child = path.join(current, d.name);
        const rel = path.relative(root, child);
        // Only list entries at depth <= depthLimit. The root is depth 0; an
        // entry N levels below the root is at depth N. `depth` here is the
        // depth of `current`, so the entry's own depth is depth + 1.
        const entryDepth = depth + 1;
        if (entryDepth > depthLimit) {
            continue;
        }
        const entry = d.isFile()
            ? { name: rel, type: 'file' }
            : d.isDirectory()
                ? { name: rel, type: 'dir' }
                : { name: rel, type: 'other' };
        if (d.isFile()) {
            // Fill in size for files. Use lstat to match the readdir kind.
            const s = await fs.lstat(child);
            entry.size = s.size;
        }
        out.push(entry);
        if (recursive && d.isDirectory() && entryDepth < depthLimit) {
            await walk(root, child, recursive, depthLimit, depth + 1, out, signal);
        }
    }
}
//# sourceMappingURL=list-dir.js.map