/**
 * `lumen memory` — inspect and manage the markdown
 * memory bridge.
 *
 * Sub-commands:
 *   - `sync`  (default): pull high-trust facts from
 *     sqlite → MEMORY.md / USER.md; if a hand-edit is
 *     newer than the last sync, ingest it back into
 *     sqlite.
 *   - `show`: print the resolved memory.md / user.md
 *     paths + the bridge's last sync mtime.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import {
  createMemoryMarkdownBridge,
  defaultMemoryMdPath,
  defaultUserMdPath,
} from '../memory-markdown-bridge.js'

/** Same path resolution as the agent runtime + session
 *  command — keep all three in sync. */
const defaultMemoryDbPath = (): string => {
  const override = process.env.LUMEN_MEMORY_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'memory.db')
}

/**
 * Open the SQLite store + bridge, run a function, always
 * dispose. The bridge is *idempotent* — calling sync twice
 * in a row produces the same bytes — so wrapping it in a
 * `withStore` is safe.
 */
const withBridge = async <T>(
  fn: (bridge: ReturnType<typeof createMemoryMarkdownBridge>, store: SqliteStore) => Promise<T>,
  options: MemoryCommandOptions = {},
): Promise<T> => {
  const dbPath = options.memoryPath ?? defaultMemoryDbPath()
  const store = new SqliteStore({ path: dbPath })
  try {
    try {
      await store.init()
    } catch {
      // fresh install — listFacts returns [] and the
      // sync produces an empty doc rather than crashing.
    }
    const bridge = createMemoryMarkdownBridge({
      store,
      ...(options.memoryMdPath !== undefined ? { memoryMdPath: options.memoryMdPath } : {}),
      ...(options.userMdPath !== undefined ? { userMdPath: options.userMdPath } : {}),
      ...(options.trustThreshold !== undefined ? { trustThreshold: options.trustThreshold } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
    })
    return await fn(bridge, store)
  } finally {
    await store.dispose()
  }
}

export interface MemoryCommandOptions {
  /** Override the SQLite path. */
  readonly memoryPath?: string
  /** Override MEMORY.md path. */
  readonly memoryMdPath?: string
  /** Override USER.md path. */
  readonly userMdPath?: string
  /** Override trust threshold (default 0.6). */
  readonly trustThreshold?: number
  /** Profile label written into the markdown frontmatter. */
  readonly profile?: string
}

/** `lumen memory sync` — pull sqlite → md, ingest if newer. */
export const memorySyncCommand = async (opts: MemoryCommandOptions = {}): Promise<number> => {
  return await withBridge(async (bridge) => {
    const ingested = await bridge.ingestIfNewer()
    const pushed = await bridge.syncAfterRun()
    process.stdout.write(
      `lumen memory sync:\n  ingested: ${ingested.ingested} (skipped ${ingested.skipped})\n  pushed:   MEMORY.md=${pushed.memoryFacts}, USER.md=${pushed.userFacts}\n`,
    )
    return 0
  }, opts)
}

/** `lumen memory show` — print the resolved paths + last
 *  sync mtime. */
export const memoryShowCommand = async (opts: MemoryCommandOptions = {}): Promise<number> => {
  return await withBridge(async (bridge) => {
    const desc = bridge.describe()
    process.stdout.write(
      `memory markdown bridge:\n  MEMORY.md: ${desc.memoryMdPath}\n  USER.md:   ${desc.userMdPath}\n  last sync: ${desc.lastSyncMs > 0 ? new Date(desc.lastSyncMs).toISOString() : '(never)'}\n`,
    )
    return 0
  }, opts)
}

/** Re-export path helpers for tests + other commands. */
export { defaultMemoryMdPath, defaultUserMdPath }
