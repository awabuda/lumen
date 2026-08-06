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
    const target = opts.sessionId ? sessions.find((s) => s.id === opts.sessionId) : sessions[0]
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
    process.stdout.write(`reflected ${persisted}/${facts.length} facts from session ${target.id}\n`)
    return 0
  } finally {
    await store.dispose()
  }
}

export interface ReflectMetaOptions {
  readonly memoryPath?: string
  readonly interval?: number
  readonly similarityThreshold?: number
  /**
   * P44.a — output format. 'human' (default) is
   * the pre-P44.a one-line text; 'json' emits a
   * structured object (CI-friendly). Brings `meta`
   * to parity with `list` (P35.d). The `meta`
   * action does mutate the memory store
   * (applies trust-delta patches), so the JSON
   * shape includes the patch list before any
   * apply step:
   *   { proposed, applied, patches: [...] }
   */
  readonly format?: 'human' | 'json'
  /**
   * P48.e — when true, do NOT actually apply
   * the trust-delta patches. Instead, emit the
   * pre-apply patch list. Useful in CI to gate
   * a meta-reflect run on the proposed change
   * count. Mirrors the `plan approve --dry-run`
   * (P46.b) / `plan reject --dry-run` (P47.a)
   * pattern. The human path emits
   * `would apply <n> trust-delta patches`;
   * the JSON path emits the same shape the
   * apply path would.
   */
  readonly dryRun?: boolean
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
    if (opts.format === 'json') {
      // P44.a — emit the patch list as JSON so CI
      // can decide whether to apply via the dispatcher.
      // The pre-P44.a `apply` step is intentionally
      // baked into the same dispatch (the meta reflector
      // is single-process and the cost of re-running
      // is negligible), so the JSON object includes
      // both the proposed and the applied counts.
      process.stdout.write(
        `${JSON.stringify(
          {
            proposed: patches.length,
            patches: patches.map((p) => ({
              recordId: p.recordId,
              nextTrust: p.nextTrust,
              delta: p.delta,
              clusterSize: p.clusterSize,
            })),
          },
          null,
          2,
        )}\n`,
      )
      // The apply step is still performed in-process
      // (the `format: json` flag is a reporting knob,
      // not a control flow change). The shape above is
      // the pre-apply snapshot; the human path
      // surfaces the post-apply summary line.
      // P48.e — when dryRun is true, return without
      // applying the patches. The JSON path is the
      // pre-apply snapshot; the apply step is skipped.
      if (opts.dryRun === true) {
        return 0
      }
    } else if (opts.dryRun === true) {
      // P48.e — human path: emit a summary line
      // and skip the apply step.
      process.stdout.write(
        `would apply ${patches.length} trust-delta patches (no changes written)\n`,
      )
      return 0
    }
    if (patches.length === 0) {
      if (opts.format !== 'json') {
        process.stdout.write('(no fact clusters formed; nothing to adjust)\n')
      }
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
    if (opts.format === 'json') {
      // P44.a — append the post-apply summary so
      // the JSON path is self-contained.
      process.stdout.write(`${JSON.stringify({ applied, total: patches.length })}\n`)
      return 0
    }
    process.stdout.write(`applied ${applied}/${patches.length} trust-delta patches\n`)
    return 0
  } finally {
    await store.dispose()
  }
}

export interface ReflectListOptions {
  readonly memoryPath?: string
  /** P35.d — `human` (default) prints one line per record;
   *  `json` prints a single JSON array (CI-friendly). */
  readonly format?: 'human' | 'json'
  /**
   * P35.d — Max records to print. Default 50.
   * P48.d — renamed `--list-limit` to align with
   * the P44.c convention used by
   * `session list --list-limit`. The pre-P48.d
   * name `limit` was renamed to `listLimit` so
   * the flag can be wired through the dispatcher
   * without colliding with the future
   * `reflect show --limit` flag (if any).
   */
  readonly listLimit?: number
  /**
   * P49.c — `list` only: when true, omit the
   * `content` field from each record in the
   * JSON output. The pre-P49.c shape always
   * included a 200-char `content` preview
   * (truncated from the full record text).
   * Default `false` (no surface change).
   * CI consumers that just need the id +
   * trust + createdAt can use this flag to
   * halve the JSON payload size on long
   * reflection lists.
   */
  readonly noContent?: boolean
}

/**
 * P35.d — `lumen reflect list` reads the SqliteStore
 * and prints every `kind: 'reflection'` record. The
 * command is read-only: it does NOT mutate the
 * memory store. The output is sorted by `createdAt`
 * (newest first) so the operator sees the most-recent
 * reflector output at the top.
 */
export const reflectListCommand = async (opts: ReflectListOptions = {}): Promise<number> => {
  const { SqliteStore } = await import('@lumen/memory')
  const dbPath = opts.memoryPath ?? defaultMemoryPath()
  let store: InstanceType<typeof SqliteStore> | undefined
  try {
    store = new SqliteStore({ path: dbPath })
    await store.init()
  } catch (err) {
    process.stderr.write(`lumen reflect list: cannot open ${dbPath}: ${(err as Error).message}\n`)
    return 1
  }
  try {
    const limit = opts.listLimit ?? 50
    // Fetch by kind. The high maxTrust-low limit is so
    // we don't lose any record (trust filtering is the
    // operator's CLI job, not the CLI's).
    const records = await store.search({ kind: 'reflection', limit: 10_000 })
    const sorted = records
      .map((r) => r.record)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
    if (sorted.length === 0) {
      if (opts.format === 'json') {
        process.stdout.write('[]\n')
      } else {
        process.stdout.write('(no reflection records; run `lumen reflect run` first)\n')
      }
      return 0
    }
    if (opts.format === 'json') {
      process.stdout.write(
        `${JSON.stringify(
          sorted.map((r) => ({
            id: r.id,
            trust: r.trust,
            createdAt: r.createdAt,
            // P49.c — `--no-content` drops the
            // `content` field from each record.
            // CI consumers that just need the id
            // + trust + createdAt can use this
            // flag to halve the JSON payload
            // size on long reflection lists.
            ...(opts.noContent !== true ? { content: r.content.slice(0, 200) } : {}),
          })),
          null,
          2,
        )}\n`,
      )
      return 0
    }
    process.stdout.write(`Reflection records (${sorted.length}):\n\n`)
    for (const r of sorted) {
      process.stdout.write(
        `  ${r.id}  trust=${r.trust.toFixed(2)}  createdAt=${r.createdAt}\n    ${r.content.slice(0, 160)}\n\n`,
      )
    }
    return 0
  } finally {
    await store.dispose()
  }
}

/** Touched only so the import is considered used; `fs` is reserved
 *  for future flag-controlled read-from-disk behaviours. */
void fs
