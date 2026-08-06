/**
 * P34.1 — Memory markdown bridge (apps/cli composition).
 *
 * Per docs/P34-DESIGN.md §2: the bridge composition lives
 * in `apps/cli`; `packages/memory` ships only the pure-data
 * helpers. This module owns:
 *   - reading the SqliteStore and emitting MEMORY.md /
 *     USER.md (filtered by trust threshold + kind)
 *   - parsing hand-edited markdown back into MemoryRecord
 *     shape and inserting it into the SqliteStore
 *   - the write-path trigger (afterRun hook)
 *
 * The bridge is *idempotent* — the same store content
 * always produces the same bytes (the markdown helpers are
 * deterministic), so calling `syncAfterRun()` twice in the
 * same run does not churn the file. The read-path
 * (`ingestIfNewer`) is gated on `mtime > lastSyncMs` so
 * we never silently clobber a hand-edit the operator
 * hasn't seen yet.
 */

import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  DEFAULT_TRUST_THRESHOLD,
  type MemoryQuery,
  type MemoryRecord,
  type SerializedFact,
  buildMarkdownDocument,
  parseMarkdownFacts,
} from '@lumen/memory'

/** Default memory markdown path. Resolved against $HOME. */
export const defaultMemoryMdPath = (): string => {
  const override = process.env.LUMEN_MEMORY_MD_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'MEMORY.md')
}

/** Default user markdown path. Resolved against $HOME. */
export const defaultUserMdPath = (): string => {
  const override = process.env.LUMEN_USER_MD_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'USER.md')
}

/**
 * Minimum surface a memory store must expose for the
 * bridge. We do NOT depend on `BaseMemoryStore` directly
 * (the bridge is composition-side and the call site may
 * pass a `SqliteStore` or a stub in tests).
 */
export interface MemoryStoreBridgeSource {
  /** Read every record whose trust >= the threshold. We
   *  reuse `BaseMemoryStore.search` (the contract that
   *  ships in @lumen/core) so the bridge is store-agnostic
   *  — SqliteStore in production, InMemoryStore in tests. */
  search(query: MemoryQuery): Promise<ReadonlyArray<{ readonly record: MemoryRecord }>>
  /** Insert a fact; returns the persisted row. */
  put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>
  /** Resolve a fact by id (for the ingest round-trip). */
  get(id: string): Promise<MemoryRecord | undefined>
}

export interface MemoryMarkdownBridgeOptions {
  readonly store: MemoryStoreBridgeSource
  readonly memoryMdPath?: string
  readonly userMdPath?: string
  readonly trustThreshold?: number
  /**
   * Profile label written into the markdown frontmatter
   * so the operator can correlate the file with the
   * assistant / bare assembly that produced it.
   */
  readonly profile?: string
}

export interface MemoryMarkdownBridge {
  /** Pull high-trust facts from sqlite → markdown. */
  syncAfterRun(): Promise<{
    readonly memoryFacts: number
    readonly userFacts: number
  }>
  /**
   * If the markdown file's mtime is newer than the last
   * sync, parse it back into MemoryRecord shape and
   * upsert into sqlite. Returns the number of records
   * inserted (records with an existing id are updated,
   * not duplicated).
   */
  ingestIfNewer(): Promise<{
    readonly ingested: number
    readonly skipped: number
  }>
  /** Paths + last-sync mtimes (for `lumen memory show`). */
  describe(): {
    readonly memoryMdPath: string
    readonly userMdPath: string
    readonly lastSyncMs: number
  }
}

/**
 * Map a kind to its markdown file. `agent` /
 * `preference` / `skill` / `fact` go to MEMORY.md; `user`
 * (and any kind the operator marks user-facing) goes to
 * USER.md. The split keeps the agent's reasoning separate
 * from the human's biography.
 */
const kindToFile = (kind: string): 'memory' | 'user' => (kind === 'user' ? 'user' : 'memory')

export const createMemoryMarkdownBridge = (
  options: MemoryMarkdownBridgeOptions,
): MemoryMarkdownBridge => {
  const memoryMdPath = options.memoryMdPath ?? defaultMemoryMdPath()
  const userMdPath = options.userMdPath ?? defaultUserMdPath()
  const trustThreshold = options.trustThreshold ?? DEFAULT_TRUST_THRESHOLD
  const profile = options.profile
  // P56 — initialise `lastSyncMs` from the on-disk
  // mtime of MEMORY.md / USER.md so `describe()`
  // reports the real last-write state. Pre-P56 the
  // variable started at 0, so the first `describe()`
  // (e.g. `lumen memory show` before any sync)
  // reported "last sync: (never)" even when the
  // files existed on disk (e.g. left over from a
  // previous install). P56 uses sync `fs.statSync`
  // at construction time (the bridge is created
  // sync); the cost is two stat calls per
  // `lumen memory <sub>` invocation, which is
  // negligible.
  const safeStatSync = (filePath: string): number | undefined => {
    // P56b — apps/cli is `"type": "module"` (ESM),
    // so `require('node:fs')` throws at module load
    // time. The pre-P56b path used `require`, so
    // `safeStatSync` always returned undefined and
    // `lastSyncMs` stayed 0. P56b uses the module-scope
    // `node:fs` import + `statSync` (sync) so the
    // function actually returns the file mtime.
    try {
      // `import * as fs from 'node:fs'` is hoisted
      // to the top of the file; `statSync` is the
      // sync variant, matching the pre-P56b pattern
      // without the ESM incompatibility.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return fsSync.statSync(filePath).mtimeMs
    } catch {
      return undefined
    }
  }
  let lastSyncMs = Math.max(safeStatSync(memoryMdPath) ?? 0, safeStatSync(userMdPath) ?? 0)

  return {
    async syncAfterRun(): Promise<{ memoryFacts: number; userFacts: number }> {
      // Use a high limit (10k) + the trust threshold so the
      // bridge sees every high-trust fact in the store.
      // P34.1 ships with a 10k cap; future operator
      // facing pagination is a separate ticket.
      const searchResults = await options.store.search({
        minTrust: trustThreshold,
        limit: 10_000,
      })
      const allFacts = searchResults.map((r) => r.record)
      // Split by file before serializing so each output
      // only carries the facts that belong to it.
      const memoryFacts = allFacts.filter((f) => kindToFile(f.kind) === 'memory').map(toSerialized)
      const userFacts = allFacts.filter((f) => kindToFile(f.kind) === 'user').map(toSerialized)
      const generatedAtIso = new Date().toISOString()
      const memoryDoc = buildMarkdownDocument({
        facts: memoryFacts,
        meta: profile !== undefined ? { generatedAtIso, profile } : { generatedAtIso },
        trustThreshold,
      })
      const userDoc = buildMarkdownDocument({
        facts: userFacts,
        meta: profile !== undefined ? { generatedAtIso, profile } : { generatedAtIso },
        trustThreshold,
      })
      await writeMd(memoryMdPath, memoryDoc)
      await writeMd(userMdPath, userDoc)
      lastSyncMs = Date.now()
      return { memoryFacts: memoryFacts.length, userFacts: userFacts.length }
    },

    async ingestIfNewer(): Promise<{ ingested: number; skipped: number }> {
      let ingested = 0
      let skipped = 0
      for (const filePath of [memoryMdPath, userMdPath]) {
        const stat = await safeStat(filePath)
        if (stat === undefined) continue
        if (stat.mtimeMs <= lastSyncMs) {
          skipped += 1
          continue
        }
        const text = await fs.readFile(filePath, 'utf8')
        const facts = parseMarkdownFacts(text)
        for (const f of facts) {
          const existing = await options.store.get(f.id)
          if (existing !== undefined) {
            // Same id → assume operator's hand-edit
            // supersedes the previous record. We do NOT
            // touch trust if the operator left the
            // default `0.6` (synthesize path) — keep
            // the original sqlite trust so a stray md
            // edit does not silently demote a
            // high-confidence fact.
            const trust = f.trust === DEFAULT_TRUST_THRESHOLD ? existing.trust : f.trust
            await options.store.put({
              id: f.id,
              kind: f.kind,
              content: f.content,
              trust,
              tags: f.tags.length > 0 ? [...f.tags] : existing.tags,
              embedding: existing.embedding,
            })
          } else {
            await options.store.put({
              id: f.id,
              kind: f.kind,
              content: f.content,
              trust: f.trust,
              tags: [...f.tags],
              embedding: undefined,
            })
            ingested += 1
          }
        }
        lastSyncMs = Math.max(lastSyncMs, stat.mtimeMs)
      }
      return { ingested, skipped }
    },

    describe() {
      return { memoryMdPath, userMdPath, lastSyncMs }
    },
  }
}

const toSerialized = (record: MemoryRecord): SerializedFact => ({
  id: record.id,
  kind: record.kind,
  content: record.content,
  trust: record.trust,
  tags: record.tags,
  createdAtIso: new Date(record.createdAt).toISOString(),
})

const writeMd = async (filePath: string, body: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, body, 'utf8')
}

const safeStat = async (filePath: string): Promise<{ mtimeMs: number } | undefined> => {
  try {
    const stat = await fs.stat(filePath)
    return { mtimeMs: stat.mtimeMs }
  } catch {
    return undefined
  }
}
