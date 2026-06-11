/**
 * Built-in toolsets shipped with `@lumen/tools`.
 *
 * Each toolset is a named, lazy-initialised bundle of
 * {@link BaseTool} instances. The CLI composition root
 * iterates this list to wire the default palette lazily;
 * the user can opt in to a subset by id via
 * `lumen.tools.enabled` in their config.
 */

import {
  BaseToolset,
  StaticToolset,
  type ToolsetFactory,
} from '@lumen/core'
import { createDefaultTools, createMetaTools, createGithubTools } from './index.js'

/** The filesystem + terminal palette. */
export const FS_TOOLSET: BaseToolset = new StaticToolset({
  id: 'fs',
  name: 'Filesystem & Terminal',
  description: 'read_file, write_file, patch, list_dir, search_files, terminal',
  factory: createDefaultTools as ToolsetFactory,
})

/** Meta tools (date, env, whoami). */
export const META_TOOLSET: BaseToolset = new StaticToolset({
  id: 'meta',
  name: 'Meta',
  description: 'date, env, whoami — inspect the agent runtime',
  factory: createMetaTools as ToolsetFactory,
})

/** GitHub bridge (git, gh). */
export const GITHUB_TOOLSET: BaseToolset = new StaticToolset({
  id: 'github',
  name: 'GitHub',
  description: 'git, gh — version control and PR management',
  factory: createGithubTools as ToolsetFactory,
})

/** Every toolset that ships with `@lumen/tools`. */
export const BUILT_IN_TOOLSETS: ReadonlyArray<BaseToolset> = [
  FS_TOOLSET,
  META_TOOLSET,
  GITHUB_TOOLSET,
]
