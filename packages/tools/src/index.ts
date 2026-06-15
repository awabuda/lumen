/**
 * @lumen/tools — default tools for the Lumen agent framework.
 *
 * This package ships a small, opinionated set of {@link BaseTool}
 * subclasses that the agent loop can use out of the box. They cover
 * the most common operations an LLM needs: reading, writing,
 * patching, listing, and searching the filesystem; running shell
 * commands inside a pluggable sandbox; and a curated subset of
 * `git` operations.
 *
 * Quick start:
 *
 * ```ts
 * import { ToolRegistry } from '@lumen/core'
 * import { createFilesystemTools, createShellTools, createGitTools } from '@lumen/tools'
 *
 * const registry = new ToolRegistry()
 * registry.registerAll([
 *   ...createFilesystemTools(),
 *   ...createShellTools(),
 *   ...createGitTools(),
 * ])
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

// Shell sandbox abstractions
export {
  type ShellSandbox,
  type ShellSandboxConfig,
  type ShellSandboxFactory,
  type ShellSandboxRequest,
  type ShellSandboxResult,
  type ShellSandboxOutcome,
  type ShellSandboxRefusalReason,
  resolveSandbox,
  awaitChild,
} from './shell/sandbox.js'

export { DefaultSandbox } from './shell/default-sandbox.js'
export { NoneSandbox } from './shell/none-sandbox.js'
export {
  DEFAULT_SANDBOX_FACTORIES,
  withSandboxFactory,
  defaultShellSandboxConfig,
} from './shell/factories.js'

export { TerminalTool, TerminalInputSchema, TerminalOutputSchema } from './shell/terminal.js'
export type { TerminalInput, TerminalOutput } from './shell/terminal.js'

export { GitTool, GitInputSchema, GitOutputSchema } from './git/git.js'
export type { GitInput, GitOutput, GitOp } from './git/git.js'

export { DateTool, DateInputSchema, DateOutputSchema } from './meta/date.js'
export type { DateInput, DateOutput } from './meta/date.js'

export { EnvTool, EnvInputSchema, EnvOutputSchema } from './meta/env.js'
export type { EnvInput, EnvOutput } from './meta/env.js'

export { WhoamiTool, WhoamiInputSchema, WhoamiOutputSchema } from './meta/whoami.js'
export type { WhoamiInput, WhoamiOutput } from './meta/whoami.js'

export { GhTool, GhInputSchema, GhOutputSchema } from './github/gh.js'
export type { GhInput, GhOutput, GhOp } from './github/gh.js'

export { FileNotFoundError, PathKindError } from './errors.js'

export { BaseTool, ToolRegistry } from './base.js'
export type { ToolContext, ToolDescriptor, ToolRisk } from './base.js'

export {
  BUILT_IN_TOOLSETS,
  FS_TOOLSET,
  META_TOOLSET,
  GITHUB_TOOLSET,
} from './toolsets.js'

import { ReadFileTool } from './fs/read-file.js'
import { WriteFileTool } from './fs/write-file.js'
import { PatchTool } from './fs/patch.js'
import { ListDirTool } from './fs/list-dir.js'
import { SearchFilesTool } from './fs/search-files.js'
import { TerminalTool } from './shell/terminal.js'
import { GitTool } from './git/git.js'
import { DateTool } from './meta/date.js'
import { EnvTool } from './meta/env.js'
import { WhoamiTool } from './meta/whoami.js'
import { GhTool } from './github/gh.js'
import type { ShellSandboxConfig } from './shell/sandbox.js'
import { defaultShellSandboxConfig } from './shell/factories.js'
import type { BaseTool } from './base.js'

/**
 * Build the default set of filesystem tools in the canonical order
 * (read, write, patch, list, search). The array is fresh on every call
 * so callers are free to mutate, slice, or extend it.
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

/**
 * Build the shell tools. Today that's just the `terminal` tool, but
 * the factory exists so future shell-aware tools (`run_script`,
 * `apply_patch` on a shell, etc.) can be added here without breaking
 * the import shape callers depend on.
 *
 * Pass a custom `ShellSandboxConfig` to swap the strategy (e.g.
 * `strategy: 'none'` for a hard-disable deployment, or
 * `strategy: 'docker'` after registering the docker factory via
 * {@link withSandboxFactory}).
 */
export function createShellTools(sandboxConfig?: ShellSandboxConfig): BaseTool[] {
  return [new TerminalTool(sandboxConfig ?? defaultShellSandboxConfig())]
}

/**
 * Build the git tools. Today that's just the `git` tool, but the
 * factory exists for the same reason as {@link createShellTools}.
 */
export function createGitTools(): BaseTool[] {
  return [new GitTool()]
}

/**
 * Build **all** the default tools in canonical order.
 *
 * Composition root for the CLI: a single import gives the agent the
 * whole tool palette ready for {@link ToolRegistry.registerAll}.
 */
export function createDefaultTools(): BaseTool[] {
  return [...createFilesystemTools(), ...createShellTools(), ...createGitTools(), ...createMetaTools(), ...createGithubTools()]
}

/**
 * Build the meta / utility tools (date, env, whoami).
 * These are small, safe tools that help the agent orient itself.
 */
export function createMetaTools(): BaseTool[] {
  return [new DateTool(), new EnvTool(), new WhoamiTool()]
}

/**
 * Build the GitHub tools. Today that's just the `gh` tool.
 */
export function createGithubTools(): BaseTool[] {
  return [new GhTool()]
}

// Web tools
export {
  BaseSearchProvider,
  DuckDuckGoSearchProvider,
  DuckDuckGoSearchProviderOptionsSchema,
  InMemorySearchProvider,
  WebFetchInputSchema,
  WebFetchOutputSchema,
  WebFetchTool,
  WebSearchInputSchema,
  WebSearchOutputSchema,
  WebSearchTool,
  SearchResultSchema,
  createWebTools,
  type CreateWebToolsOptions,
  type DuckDuckGoSearchProviderOptions,
  type InMemorySearchProviderOptions,
  type SearchResult,
} from './web/index.js'

// Text tools (P5.2)
export {
  ChunkTextTool,
  ChunkTextInputSchema,
  ChunkTextOutputSchema,
} from './text/chunk-text.js'
export type { ChunkTextInput, ChunkTextOutput } from './text/chunk-text.js'
export {
  chunkText,
  DEFAULT_CHUNK_MAX_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  type ChunkOptions,
  type ChunkStrategy,
  type TextChunk,
} from './text/chunker.js'
