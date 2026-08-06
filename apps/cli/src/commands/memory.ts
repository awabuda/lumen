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
  /**
   * P38.b — `list` action: optional kind filter. When set,
   * only records whose `kind === filterKind` are
   * returned. Pre-P38.b the list was always 'fact'
   * (the markdown bridge's projection target); the
   * filter now lets operators see reflection / session
   * / user-pref records too.
   */
  readonly filterKind?: string
  /**
   * P47.d — `list` action: optional kind exclusion.
   * Inverse of `filterKind`: records whose
   * `kind === excludeKind` are removed from the
   * result. Useful for `lumen memory list
   * --exclude-kind reflection` (drop noise from
   * the operator's audit pass). Default undefined
   * (no exclusion). Mutually exclusive with
   * `filterKind` in the dispatcher — the operator
   * picks one or the other, not both.
   */
  readonly excludeKind?: string
  /** P38.b — `list` action: max records to print. Default 50. */
  readonly limit?: number
  /**
   * P45.d — `list` action: when true, skip the
   * `minTrust` floor (default 0.6 for the
   * `memory.list` projection). Setting `noTrust`
   * to true makes the list return every record
   * regardless of the trust floor. CI can use
   * this to audit the entire memory store.
   */
  readonly noTrust?: boolean
  /**
   * P38.b + P39.b — output format. 'human' (default)
   * emits the pre-P38.b one-line-per-section text
   * layout; 'json' emits a structured object (CI-friendly).
   * Used by both `list` and `show` (P39.b brings
   * `show` to parity with `list --format json`).
   */
  readonly format?: 'human' | 'json'
  /**
   * P40.d — `show` action: when true, additionally
   * enumerate every record in the SqliteStore and
   * emit a per-kind count. Default `false` (preserves
   * pre-P40.d behaviour).
   */
  readonly verbose?: boolean
  /**
   * P43.c — `show` action: when set with `--verbose`,
   * restrict the per-kind count to this single kind.
   * Useful for `lumen memory show --verbose --kind
   * reflection` to confirm a single record class is
   * accumulating as expected. The shape is unchanged
   * — `kindCounts` still emits `{ <kind>: <n> }` but
   * with at most one entry.
   */
  readonly kindFilter?: string
  /**
   * P42.c — `prune` action: when true, gate the
   * destructive delete step. The pre-P42.c path
   * was a no-op (no prune action existed). The
   * operator must pass `--force` to actually
   * delete records; without it, the dry-run path
   * reports how many records WOULD be removed.
   */
  readonly force?: boolean
  /**
   * P42.c — `prune` action: when true, run the
   * dry-run path (count would-delete records,
   * emit JSON). Without `--force`, `prune` runs
   * in dry-run mode by default. CI surfaces
   * can pipe through `jq` to inspect the
   * `removed` count.
   */
  readonly dryRun?: boolean
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

/** P40.d — `lumen memory show --verbose`. The default
 *  (human + no --verbose) prints the bridge paths; with
 *  `--verbose` we also enumerate every record in the
 *  SqliteStore and emit a per-kind count. Useful for
 *  operators sanity-checking that the bridge's last sync
 *  produced the expected distribution. The count is a
 *  one-line `kind=N records` per kind, sorted by count
 *  descending. */
export const memoryShowCommand = async (opts: MemoryCommandOptions = {}): Promise<number> => {
  return await withBridge(async (bridge, store) => {
    const desc = bridge.describe()
    if (opts.format === 'json') {
      // P39.b — emit the bridge descriptor as JSON for
      // CI consumers. The shape mirrors the human
      // output, with one extra `lastSyncIso` field that
      // resolves '(never)' to null so jq / CI can
      // branch cleanly.
      const payload: Record<string, unknown> = {
        memoryMdPath: desc.memoryMdPath,
        userMdPath: desc.userMdPath,
        lastSyncMs: desc.lastSyncMs,
        lastSyncIso: desc.lastSyncMs > 0 ? new Date(desc.lastSyncMs).toISOString() : null,
      }
      if (opts.verbose === true) {
        payload.kindCounts = await computeKindCounts(store, opts.kindFilter)
      }
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      return 0
    }
    process.stdout.write(
      `memory markdown bridge:\n  MEMORY.md: ${desc.memoryMdPath}\n  USER.md:   ${desc.userMdPath}\n  last sync: ${desc.lastSyncMs > 0 ? new Date(desc.lastSyncMs).toISOString() : '(never)'}\n`,
    )
    if (opts.verbose === true) {
      const counts = await computeKindCounts(store, opts.kindFilter)
      const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
      if (entries.length === 0) {
        process.stdout.write('  (no records)\n')
      } else {
        process.stdout.write('  kind counts:\n')
        for (const [k, n] of entries) process.stdout.write(`    ${k}=${n}\n`)
      }
    }
    return 0
  }, opts)
}

/** P40.d — pull every record from the store and bucket
 *  by kind. The SqliteStore.search path already supports
 *  an optional `kind` filter; for the per-kind count we
 *  fetch all (with a generous limit) so the result
 *  reflects the whole store, not a subset.
 *  P43.c — when `kindFilter` is set, restrict to that
 *  single kind. The returned object still has the
 *  same `{ <kind>: <n> }` shape but with at most one
 *  key. */
const computeKindCounts = async (
  store: SqliteStore,
  kindFilter?: string,
): Promise<Record<string, number>> => {
  const records = await store.search({
    limit: 100_000,
    ...(kindFilter !== undefined ? { kind: kindFilter } : {}),
  })
  const counts: Record<string, number> = {}
  for (const r of records) {
    const k = r.record.kind
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts
}
/** P38.b — `lumen memory list [--kind <k>]` — print every record
 *  in the SqliteStore, optionally filtered by kind. The default
 *  output is the one-line-per-record layout; `--format json`
 *  emits a JSON array (CI-friendly). The list is sorted by
 *  `createdAt` (newest first) and capped by `--limit` (50 by
 *  default).
 */
export const memoryListCommand = async (opts: MemoryCommandOptions = {}): Promise<number> => {
  const limit = opts.limit ?? 50
  return await withBridge(async (_bridge, store) => {
    // P45.d — when noTrust is set, omit the
    // `minTrust` floor. The pre-P45.d default is
    // 0.6 (the markdown bridge's projection
    // target). The `noTrust` flag drops the
    // floor to 0 so the list returns every
    // record regardless of trust.
    const minTrust = opts.noTrust === true ? 0 : 0.6
    const records = await store.search({
      ...(opts.filterKind !== undefined ? { kind: opts.filterKind } : {}),
      minTrust,
      limit: 10_000,
    })
    const filtered =
      opts.excludeKind !== undefined
        ? records.filter((r) => r.record.kind !== opts.excludeKind)
        : records
    const sorted = filtered
      .map((r) => r.record)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
    if (opts.format === 'json') {
      const rows = sorted.map((r) => ({
        id: r.id,
        kind: r.kind,
        trust: r.trust,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        content: r.content.slice(0, 200),
      }))
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
      return 0
    }
    if (sorted.length === 0) {
      const where = opts.filterKind !== undefined ? ` (kind=${opts.filterKind})` : ''
      process.stdout.write(`(no memory records${where})\n`)
      return 0
    }
    process.stdout.write(
      `Memory records (${sorted.length}${opts.filterKind !== undefined ? `, kind=${opts.filterKind}` : ''}):\n\n`,
    )
    for (const r of sorted) {
      process.stdout.write(
        `  ${r.id}  kind=${r.kind}  trust=${r.trust.toFixed(2)}  createdAt=${r.createdAt}\n    ${r.content.slice(0, 160)}\n\n`,
      )
    }
    return 0
  }, opts)
}
/**
 * P42.c — `lumen memory prune [--kind <k>]` deletes
 * every record whose `kind === pruneKind` (or, when
 * `--kind` is omitted, every record). The action
 * is destructive and gated behind `--force`:
 * without `--force`, `prune` runs in dry-run mode
 * and reports how many records WOULD be removed.
 *
 * The operator can pipe the dry-run output through
 * `jq` to gate the delete on a threshold (e.g.
 * `prune --force --kind reflection \\| jq '.removed \|> 100'`).
 *
 * P42.c — also adds `--kind <k>` (already generic
 * in P38.b for `list`; here we accept it as a
 * single-token kind filter). The dispatcher
 * enforces `--kind <k>` is the only positional
 * flow; the path is intentionally narrow.
 *
 * Subtle: the agent loop should NOT depend on
 * this command (the inner-loop reflects into the
 * same store). The pre-P42.c absence of a
 * destructive prune CLI was a deliberate "no
 * footgun" choice. P42.c ships the CLI but every
 * flag is gated behind `--force` so the default
 * path stays dry-run.
 */
export const memoryPruneCommand = async (opts: MemoryCommandOptions = {}): Promise<number> => {
  const pruneKind = opts.filterKind
  if (opts.dryRun === true || opts.force !== true) {
    // P42.c — dry-run path. Count would-delete
    // records without invoking `store.delete`.
    // Mirrors the `session prune --dry-run`
    // (P44.b) pattern.
    return await withBridge(async (_bridge, store) => {
      const records = await store.search({
        ...(pruneKind !== undefined ? { kind: pruneKind } : {}),
        limit: 100_000,
      })
      const removed = records.length
      if (opts.format === 'json') {
        process.stdout.write(
          `${JSON.stringify(
            {
              dryRun: true,
              removed,
              ...(pruneKind !== undefined ? { kind: pruneKind } : {}),
            },
            null,
            2,
          )}\n`,
        )
      } else {
        process.stdout.write(
          `would prune ${removed} record(s)${pruneKind !== undefined ? ` (kind=${pruneKind})` : ''}\n`,
        )
      }
      return 0
    }, opts)
  }
  // P42.c — force path. Iterate the search result
  // and call `store.delete` for each record. The
  // delete is idempotent at the row level; if a
  // record was deleted between search and delete,
  // the call returns false and we skip.
  return await withBridge(async (_bridge, store) => {
    const records = await store.search({
      ...(pruneKind !== undefined ? { kind: pruneKind } : {}),
      limit: 100_000,
    })
    let removed = 0
    for (const r of records) {
      const ok = await store.delete(r.record.id)
      if (ok) removed += 1
    }
    if (opts.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun: false,
            removed,
            ...(pruneKind !== undefined ? { kind: pruneKind } : {}),
          },
          null,
          2,
        )}\n`,
      )
    } else {
      process.stdout.write(
        `pruned ${removed} record(s)${pruneKind !== undefined ? ` (kind=${pruneKind})` : ''}\n`,
      )
    }
    return 0
  }, opts)
}

/** Re-export path helpers for tests + other commands. */
export { defaultMemoryMdPath, defaultUserMdPath }
