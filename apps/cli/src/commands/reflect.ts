/**
 * `lumen reflect` — manually trigger reflection (dev-only / debug).
 *
 * Sub-commands:
 *   - `run`: take the most recent agent session, run the rule-based
 *     reflector on its messages, and persist any new facts into
 *     the SQLite memory store.
 *   - `meta`: run the cross-run meta-reflector (P19.5) and apply
 *     the resulting trust-delta patches to the memory store.
 *
 * Why a CLI surface for reflection at all:
 *   - Reflection normally runs at run-end via the reflection
 *     middleware. The CLI escape hatch is useful when:
 *       (a) the agent was started with reflection disabled, and
 *           the operator wants to back-fill facts from history;
 *       (b) the operator wants to inspect or apply the meta
 *           reflector output without running a fresh agent loop.
 *   - This is a power-user command. The normal path is the
 *     reflection middleware inside the agent loop.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  createClusteringMetaReflector,
  persistExtractedFacts,
  ruleBasedReflect,
} from '@lumen/memory'

const defaultMemoryPath = (): string => {
  const override = process.env.LUMEN_MEMORY_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'memory.db')
}

export interface ReflectRunOptions {
  /** Override the SQLite memory database path. */
  readonly memoryPath?: string
  /** Optional session id; defaults to the most-recent session. */
  readonly sessionId?: string
}

export const reflectRunCommand = async (opts: ReflectRunOptions = {}): Promise<number> => {
  // Lazy import so the CLI binary stays small when reflect is
  // not used (better-sqlite3 is a heavy native dep).
  const { SqliteStore } = await import('@lumen/memory')
  const dbPath = opts.memoryPath ?? defaultMemoryPath()
  let store: InstanceType<typeof SqliteStore> | undefined
  try {
    store = new SqliteStore({ path: dbPath })
    await store.init()
  } catch (err) {
    process.stderr.write(`lumen reflect run: cannot open ${dbPath}: ${(err as Error).message}\n`)
    return 1
  }
  try {
    const sessions = await store.listSessions(opts.sessionId ? 1_000 : 1)
    if (sessions.length === 0) {
      process.stdout.write('(no sessions in memory store; nothing to reflect)\n')
      return 0
    }
    const target = opts.sessionId
      ? sessions.find((s) => s.id === opts.sessionId)
      : sessions[0]
    if (!target) {
      process.stderr.write(`lumen reflect run: session "${opts.sessionId}" not found\n`)
      return 1
    }
    const messages = await store.getSessionMessages(target.id, { limit: 1_000 })
    const projected = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolName ? { toolName: m.toolName } : {}),
    }))
    const facts = ruleBasedReflect(projected)
    if (facts.length === 0) {
      process.stdout.write(`(no facts extracted from session ${target.id})\n`)
      return 0
    }
    const persisted = await persistExtractedFacts(facts, store)
    process.stdout.write(
      `reflected ${persisted}/${facts.length} facts from session ${target.id}\n`,
    )
    return 0
  } finally {
    await store.dispose()
  }
}

export interface ReflectMetaOptions {
  readonly memoryPath?: string
  readonly interval?: number
  readonly similarityThreshold?: number
}

export const reflectMetaCommand = async (opts: ReflectMetaOptions = {}): Promise<number> => {
  const { SqliteStore } = await import('@lumen/memory')
  const dbPath = opts.memoryPath ?? defaultMemoryPath()
  let store: InstanceType<typeof SqliteStore> | undefined
  try {
    store = new SqliteStore({ path: dbPath })
    await store.init()
  } catch (err) {
    process.stderr.write(`lumen reflect meta: cannot open ${dbPath}: ${(err as Error).message}\n`)
    return 1
  }
  try {
    const reflector = createClusteringMetaReflector({
      ...(opts.interval !== undefined ? { interval: opts.interval } : {}),
      ...(opts.similarityThreshold !== undefined
        ? { similarityThreshold: opts.similarityThreshold }
        : {}),
    })
    const patches = await reflector.reflect(store)
    if (patches.length === 0) {
      process.stdout.write('(no fact clusters formed; nothing to adjust)\n')
      return 0
    }
    let applied = 0
    for (const patch of patches) {
      const record = await store.get(patch.recordId)
      if (!record) continue
      await store.put({
        ...record,
        trust: patch.nextTrust,
      })
      applied += 1
    }
    process.stdout.write(
      `applied ${applied}/${patches.length} trust-delta patches\n`,
    )
    return 0
  } finally {
    await store.dispose()
  }
}

/** Touched only so the import is considered used; `fs` is reserved
 *  for future flag-controlled read-from-disk behaviours. */
void fs
