/**
 * @lumen/tools — default filesystem tools for the Lumen agent framework.
 *
 * This package ships a small, opinionated set of {@link BaseTool}
 * subclasses that the agent loop can use out of the box. They cover
 * the most common filesystem operations an LLM needs: reading,
 * writing, patching, listing, and searching.
 *
 * Quick start:
 *
 * ```ts
 * import { ToolRegistry } from '@lumen/core'
 * import { createFilesystemTools } from '@lumen/tools'
 *
 * const registry = new ToolRegistry()
 * registry.registerAll(createFilesystemTools())
 * ```
 *
 * Every tool in this package:
 *   - extends {@link BaseTool} from `@lumen/core` (no duck typing);
 *   - declares its input and output as Zod schemas (single source of
 *     truth for validation, type, and JSON Schema);
 *   - resolves user-supplied paths against `ctx.cwd`;
 *   - checks `ctx.signal` in long loops.
 */

export { ReadFileTool, ReadFileInputSchema, ReadFileOutputSchema } from './fs/read-file.js'
export type { ReadFileInput, ReadFileOutput } from './fs/read-file.js'

export { WriteFileTool, WriteFileInputSchema, WriteFileOutputSchema } from './fs/write-file.js'
export type { WriteFileInput, WriteFileOutput } from './fs/write-file.js'
export { atomicWriteFile } from './fs/write-file.js'

export { PatchTool, PatchInputSchema, PatchOutputSchema } from './fs/patch.js'
export type { PatchInput, PatchOutput } from './fs/patch.js'

export { ListDirTool, ListDirInputSchema, ListDirOutputSchema } from './fs/list-dir.js'
export type { ListDirInput, ListDirOutput, ListDirEntry } from './fs/list-dir.js'

export { SearchFilesTool, SearchFilesInputSchema, SearchFilesOutputSchema } from './fs/search-files.js'
export type { SearchFilesInput, SearchFilesOutput, SearchMatch } from './fs/search-files.js'

export { FileNotFoundError, PathKindError } from './errors.js'

export { BaseTool, ToolRegistry } from './base.js'
export type { ToolContext, ToolDescriptor, ToolRisk } from './base.js'

import { ReadFileTool } from './fs/read-file.js'
import { WriteFileTool } from './fs/write-file.js'
import { PatchTool } from './fs/patch.js'
import { ListDirTool } from './fs/list-dir.js'
import { SearchFilesTool } from './fs/search-files.js'
import type { BaseTool } from './base.js'

/**
 * Build the default set of filesystem tools in the canonical order
 * (read, write, patch, list, search). The array is fresh on every call
 * so callers are free to mutate, slice, or extend it.
 *
 * Convenience wrapper for the CLI composition root: a single import
 * gives you the whole tool palette ready for {@link ToolRegistry.registerAll}.
 */
export function createFilesystemTools(): BaseTool[] {
  return [
    new ReadFileTool(),
    new WriteFileTool(),
    new PatchTool(),
    new ListDirTool(),
    new SearchFilesTool(),
  ]
}
