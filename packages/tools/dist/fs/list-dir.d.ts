/**
 * `list_dir` — list the entries of a directory, optionally recursively.
 *
 * Recursion is bounded by `maxDepth`: the root is depth 0, immediate
 * children are depth 1, and so on. Entries at `maxDepth` are returned
 * but their children are not descended into. Symlinks are not followed
 * to avoid cycles; they are reported as `other`.
 */
import { z } from 'zod';
import { BaseTool, type ToolContext, type ToolDescriptor } from '@lumen/core';
/** Zod schema for the tool's input. */
export declare const ListDirInputSchema: z.ZodObject<{
    /** Directory path, resolved against `ctx.cwd` if relative. */
    path: z.ZodString;
    /** When true, descend into subdirectories up to `maxDepth`. */
    recursive: z.ZodOptional<z.ZodBoolean>;
    /** Maximum depth for recursive listing. Defaults to 3. */
    maxDepth: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    path: string;
    recursive?: boolean | undefined;
    maxDepth?: number | undefined;
}, {
    path: string;
    recursive?: boolean | undefined;
    maxDepth?: number | undefined;
}>;
export type ListDirInput = z.infer<typeof ListDirInputSchema>;
/** One entry in a directory listing. */
export interface ListDirEntry {
    /** Base name (no path components). */
    name: string;
    /** Coarse classification. */
    type: 'file' | 'dir' | 'other';
    /** Size in bytes. Omitted for non-regular entries (e.g. directories). */
    size?: number;
}
/** Zod schema for the tool's output. */
export declare const ListDirOutputSchema: z.ZodObject<{
    entries: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        type: z.ZodUnion<[z.ZodLiteral<"file">, z.ZodLiteral<"dir">, z.ZodLiteral<"other">]>;
        size: z.ZodOptional<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        type: "file" | "dir" | "other";
        name: string;
        size?: number | undefined;
    }, {
        type: "file" | "dir" | "other";
        name: string;
        size?: number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    entries: {
        type: "file" | "dir" | "other";
        name: string;
        size?: number | undefined;
    }[];
}, {
    entries: {
        type: "file" | "dir" | "other";
        name: string;
        size?: number | undefined;
    }[];
}>;
export type ListDirOutput = z.infer<typeof ListDirOutputSchema>;
/** Tool: list directory entries, with bounded recursion. */
export declare class ListDirTool extends BaseTool {
    readonly name = "list_dir";
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: "safe";
    readonly version = "0.1.0";
    protected execute(input: unknown, ctx: ToolContext): Promise<ListDirOutput>;
    describe(): ToolDescriptor;
}
//# sourceMappingURL=list-dir.d.ts.map