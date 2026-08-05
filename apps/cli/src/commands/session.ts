/**
 * `lumen session` — inspect and manage stored agent sessions.
 *
 * Sub-commands:
 *   - `list`  (default): list every session in the default SQLite
 *     memory store, ordered by `updatedAt` desc.
 *   - `show <id>`: print the session's full message history
 *     (oldest first) plus session metadata.
 *   - `delete <id>`: delete the session **and** all of its
 *     messages. Gated behind `--force`; the operator must
 *     acknowledge the destructive nature of the operation.
 *   - `prune`: delete every session older than `--older-than`
 *     (default: 30 days). Also cascades messages.
 *
 * Why a sub-command surface and not a flat command:
 *   - `list` is the operator's first stop when "the agent
 *     forgot what we talked about" — it's the most common
 *     question and deserves a top-level sub-command.
 *   - `show` and `delete` operate on a single id; without
 *     sub-commands we'd need long-form flags and the help
 *     text would become opaque.
 *
 * All sub-commands are read-only or destructive-on-purpose;
 * there is no implicit "save" path.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { type SessionMessage, type SessionRecord, SqliteStore } from '@lumen/memory'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Resolve the SQLite path the same way the agent runtime does
 * (composition.ts: `~/.lumen/memory.db`, override via
 * `LUMEN_MEMORY_PATH`). We centralize the resolution so the
 * `list`/`show`/`delete`/`prune` paths agree on the file.
 */
const defaultMemoryPath = (): string => {
  const override = process.env.LUMEN_MEMORY_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'memory.db')
}

/**
 * Open the SQLite store, run a function, and always dispose.
 * We deliberately do **not** auto-init the schema: a missing
 * memory file is a normal state for a fresh install, and the
 * `list`/`show` commands should report "(no sessions)" rather
 * than create an empty database on disk.
 */
const withStore = async <T>(
  fn: (store: SqliteStore) => Promise<T>,
  options: SessionCommandOptions = {},
): Promise<T> => {
  const dbPath = options.memoryPath ?? defaultMemoryPath()
  const store = new SqliteStore({ path: dbPath })
  try {
    // init() is idempotent and a no-op when the schema is
    // already in place. For a fresh install that has never
    // run the agent, the file may not exist; we try init
    // and gracefully fall back to "empty store" on failure
    // so the CLI does not crash with a confusing error.
    try {
      await store.init()
    } catch {
      // ignore -- list/show will return empty
    }
    return await fn(store)
  } finally {
    await store.dispose()
  }
}

export interface SessionCommandOptions {
  /** Override the SQLite path. */
  readonly memoryPath?: string
  /** Skip confirmation for destructive operations. */
  readonly force?: boolean
  /** `prune` only: cut-off age in days. Default 30. */
  readonly olderThanDays?: number
  /** `show` only: limit messages returned. Default 100. */
  readonly limit?: number
  /**
   * P35.f — output format. 'human' (default) emits the
   * one-line-per-session layout; 'json' emits a single
   * JSON array (CI-friendly). Currently only `list`
   * honours this flag; other sub-commands degrade to
   * their pre-P35.f text path.
   */
  readonly format?: 'human' | 'json'
}
/** Format a unix-ms timestamp as a short local string. */
const formatTs = (ms: number): string => {
  if (ms <= 0) return '(unset)'
  const d = new Date(ms)
  // YYYY-MM-DD HH:MM in local time. Operators can grep on the
  // date; we deliberately skip seconds to keep the column
  // tight.
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

/** `lumen session list` (default) — list every session. */
export const sessionListCommand = async (opts: SessionCommandOptions = {}): Promise<number> => {
  let sessions: ReadonlyArray<SessionRecord> = []
  let path = ''
  await withStore(async (store) => {
    path = opts.memoryPath ?? defaultMemoryPath()
    sessions = await store.listSessions()
  }, opts)

  if (opts.format === 'json') {
    const rows = sessions.map((s) => ({
      id: s.id,
      title: s.title ?? null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`Lumen sessions (${path})\n\n`)
  if (sessions.length === 0) {
    process.stdout.write('  No sessions found.\n')
    return 0
  }
  for (const s of sessions) {
    const title = s.title ?? '(no title)'
    process.stdout.write(`  ${s.id}  updated=${formatTs(s.updatedAt)}  ${title}\n`)
  }
  return 0
}

/** `lumen session show <id>` — print session + message history. */
export const sessionShowCommand = async (
  id: string,
  opts: SessionCommandOptions = {},
): Promise<number> => {
  let session: SessionRecord | undefined
  let messages: ReadonlyArray<SessionMessage> = []
  await withStore(async (store) => {
    session = await store.getSession(id)
    if (session) {
      messages = await store.getSessionMessages(id, { limit: opts.limit ?? 100 })
    }
  }, opts)
  if (!session) {
    process.stderr.write(`Session not found: ${id}\n`)
    return 1
  }
  process.stdout.write(`Session ${session.id}\n`)
  process.stdout.write(`  title:     ${session.title ?? '(no title)'}\n`)
  process.stdout.write(`  created:   ${formatTs(session.createdAt)}\n`)
  process.stdout.write(`  updated:   ${formatTs(session.updatedAt)}\n`)
  process.stdout.write(`  messages:  ${messages.length}\n\n`)

  if (messages.length === 0) {
    process.stdout.write('  (no messages)\n')
    return 0
  }
  for (const m of messages) {
    const role = m.role.padEnd(9)
    const preview = m.content.length > 80 ? `${m.content.slice(0, 77)}...` : m.content
    process.stdout.write(`  [${formatTs(m.createdAt)}] ${role} ${preview}\n`)
    if (m.toolName) process.stdout.write(`    tool: ${m.toolName}\n`)
  }
  return 0
}

/** `lumen session delete <id>` — destructive, gated by `--force`. */
export const sessionDeleteCommand = async (
  id: string,
  opts: SessionCommandOptions = {},
): Promise<number> => {
  if (!opts.force) {
    process.stderr.write(
      `Refusing to delete session "${id}" without --force. Re-run with --force to confirm.\n`,
    )
    return 2
  }
  let removed = false
  await withStore(async (store) => {
    removed = await store.deleteSession(id)
  }, opts)
  if (!removed) {
    process.stderr.write(`Session not found: ${id}\n`)
    return 1
  }
  // P42.b — emit a JSON object on delete. Brings
  // `delete` to parity with `prune` (P41.c) and
  // `list` (P35.f). The shape includes the session
  // id and the deletion timestamp.
  if (opts.format === 'json') {
    process.stdout.write(
      `${JSON.stringify({ id, deleted: true, deletedAt: Date.now() }, null, 2)}\n`,
    )
    return 0
  }
  process.stdout.write(`Deleted session: ${id}\n`)
  return 0
}

/** `lumen session prune` — delete sessions older than `--older-than` days. */
export const sessionPruneCommand = async (opts: SessionCommandOptions = {}): Promise<number> => {
  const days = opts.olderThanDays ?? 30
  if (days < 0) {
    process.stderr.write('--older-than must be non-negative\n')
    return 2
  }
  if (!opts.force) {
    process.stderr.write(
      `Refusing to prune sessions older than ${days} day(s) without --force. Re-run with --force to confirm.\n`,
    )
    return 2
  }
  let removed = 0
  await withStore(async (store) => {
    removed = await store.prune(days * MS_PER_DAY)
  }, opts)
  // P41.c — emit a JSON object on prune. The pre-P41.c
  // shape was the single-line `Pruned <n> session/record
  // row(s) older than <d> day(s).` text. The JSON path
  // includes the cut-off ms timestamp so CI can
  // independently verify the boundary.
  if (opts.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        { removed, olderThanDays: days, cutOffMs: Date.now() - days * MS_PER_DAY },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  process.stdout.write(`Pruned ${removed} session/record row(s) older than ${days} day(s).\n`)
  return 0
}
