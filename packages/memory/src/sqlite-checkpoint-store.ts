/**
 * `SqliteCheckpointStore` — persistent {@link BaseCheckpointStore}
 * backed by `better-sqlite3` (P20.4.4).
 *
 * Why a separate store rather than reusing the existing
 * `SqliteStore`:
 *   - `SqliteStore` is a {@link BaseMemoryStore} for facts and
 *     session messages. The checkpoint interface
 *     (`BaseCheckpointStore`) is structurally different (save /
 *     get / list / delete by id, not by kind+text). Forcing the
 *     two into one class would break the single-responsibility
 *     boundary and add a kind='checkpoint' special case to
 *     every record query.
 *   - The two stores can share the same SQLite file safely
 *     (WAL journal allows concurrent readers + one writer).
 *     `lumen chat` (long-running) and `lumen checkpoint list`
 *     (one-shot) are the canonical multi-writer case.
 *   - Tier isolation: this file lives in `@lumen/memory` next
 *     to the other SQLite machinery. `@lumen/core` stays
 *     storage-agnostic — its `BaseCheckpointStore` interface
 *     is implemented here as a downstream detail.
 *
 * Schema:
 *   `checkpoints(id PK, session_id, iterations, created_at, label, messages_json)`
 *     - `messages_json` is the full agent run message history,
 *       serialised through `JSON.stringify`. The checkpoint
 *       payload can be large; SQLite's JSON column type is a
 *       TEXT column under the hood, so we use TEXT explicitly
 *       to keep the schema obvious.
 *   - `id` is the natural key (sessionId + "-" + iterations),
 *     matching the `AgentCheckpoint.id` convention.
 *   - `session_id` is indexed for the list-by-session query.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database, Statement } from 'better-sqlite3'

import type {
  AgentCheckpoint,
  BaseCheckpointStore,
  CheckpointSessionSummary,
  Message,
} from '@lumen/core'

const CHECKPOINTS_DDL = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  label         TEXT,
  outcome       TEXT,
  messages_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_session_idx ON checkpoints(session_id, created_at);
`

interface CheckpointRow {
  id: string
  session_id: string
  iterations: number
  created_at: number
  label: string | null
  outcome: 'in_progress' | 'success' | 'error' | null
  messages_json: string
}

const rowToCheckpoint = (row: CheckpointRow): AgentCheckpoint => {
  const messages: ReadonlyArray<Message> = JSON.parse(row.messages_json)
  const base: AgentCheckpoint = {
    id: row.id,
    sessionId: row.session_id,
    iterations: row.iterations,
    createdAt: row.created_at,
    messages,
  }
  return {
    ...base,
    ...(row.label ? { label: row.label } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
  }
}

const checkpointToRow = (cp: AgentCheckpoint): CheckpointRow => ({
  id: cp.id,
  session_id: cp.sessionId,
  iterations: cp.iterations,
  created_at: cp.createdAt,
  label: cp.label ?? null,
  outcome: cp.outcome ?? null,
  messages_json: JSON.stringify(cp.messages),
})

interface PreparedCheckpointStatements {
  insert: Statement
  get: Statement
  listBySession: Statement
  listSessionSummaries: Statement
  latestInProgress: Statement
  latestInProgressBySession: Statement
  delete: Statement
  deleteBySessionId: Statement
}

const prepareStatements = (db: Database): PreparedCheckpointStatements => ({
  insert: db.prepare(
    `INSERT INTO checkpoints (id, session_id, iterations, created_at, label, outcome, messages_json)
     VALUES (@id, @session_id, @iterations, @created_at, @label, @outcome, @messages_json)
     ON CONFLICT(id) DO UPDATE SET
       session_id    = excluded.session_id,
       iterations    = excluded.iterations,
       created_at    = excluded.created_at,
       label         = excluded.label,
       outcome       = excluded.outcome,
       messages_json = excluded.messages_json`,
  ),
  get: db.prepare('SELECT * FROM checkpoints WHERE id = ?'),
  listBySession: db.prepare(
    'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC',
  ),
  listSessionSummaries: db.prepare(
    "SELECT session_id, MAX(created_at) AS last_at, COUNT(*) AS cnt, " +
      "SUM(CASE WHEN outcome IS NULL OR outcome NOT IN ('success','error') THEN 1 ELSE 0 END) AS live_cnt " +
      'FROM checkpoints GROUP BY session_id ORDER BY last_at DESC',
  ),
  latestInProgress: db.prepare(
    "SELECT * FROM checkpoints WHERE (outcome = 'in_progress' OR outcome IS NULL) AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
  ),
  latestInProgressBySession: db.prepare(
    "SELECT * FROM checkpoints WHERE session_id = ? AND (outcome = 'in_progress' OR outcome IS NULL) AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
  ),
  delete: db.prepare('DELETE FROM checkpoints WHERE id = ?'),
  deleteBySessionId: db.prepare('DELETE FROM checkpoints WHERE session_id = ?'),
})

export interface SqliteCheckpointStoreOptions {
  /** Path to the SQLite file. Use `':memory:'` for tests. */
  readonly path: string
}

/**
 * A persistent {@link BaseCheckpointStore}. The store owns its
 * own database connection — to share a connection with
 * `SqliteStore`, point both at the same `path` (WAL mode lets
 * them coexist safely).
 */
export class SqliteCheckpointStore implements BaseCheckpointStore {
  public readonly id = 'sqlite'
  private readonly db: Database
  private readonly stmts: PreparedCheckpointStatements

  public constructor(options: SqliteCheckpointStoreOptions) {
    const resolved = options.path === ':memory:' ? ':memory:' : path.resolve(options.path)
    if (resolved !== ':memory:') {
      // better-sqlite3 throws `SQLITE_CANTOPEN` (driver-level) when
      // the parent directory does not exist; the rest of the stack
      // surfaces this as `lumen: unexpected error: Cannot open
      // database because the directory does not exist`. mkdirSync
      // here so chat.sqlite under $XDG_STATE_HOME or
      // ~/.local/state/lumen works on a fresh install without
      // asking the operator to mkdir first.
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
    }
    this.db = new BetterSqlite3(resolved)
    if (!this.db.name.endsWith(':memory:')) {
      this.db.pragma('journal_mode = WAL')
    }
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(CHECKPOINTS_DDL)
    const columns = this.db.pragma('table_info(checkpoints)') as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'outcome')) {
      this.db.exec('ALTER TABLE checkpoints ADD COLUMN outcome TEXT')
    }
    this.stmts = prepareStatements(this.db)
  }

  /**
   * @remarks P23.11 (fix #55) — `better-sqlite3` is synchronous; we
   * explicitly `setImmediate` after each op so the surrounding
   * async event loop sees a real microtask hop instead of a
   * fully synchronous return. The contract stays
   * `Promise<…>`-shaped so callers do not need to change; the
   * hop is small (one tick) and avoids blocking the agent
   * loop when SQLite IO hits a slow disk. Tests that assert
   * ordering still see the expected value because the resolved
   * value is the same synchronous one. The P22 async contract
   * is preserved — we are not removing async; we are making
   * it honest about the underlying sync.
   */
  public async save(checkpoint: AgentCheckpoint): Promise<AgentCheckpoint> {
    this.stmts.insert.run(checkpointToRow(checkpoint))
    await yieldToLoop()
    return checkpoint
  }

  public async get(id: string): Promise<AgentCheckpoint | undefined> {
    const row = this.stmts.get.get(id) as CheckpointRow | undefined
    await yieldToLoop()
    return row ? rowToCheckpoint(row) : undefined
  }

  public async list(sessionId: string): Promise<ReadonlyArray<AgentCheckpoint>> {
    const rows = this.stmts.listBySession.all(sessionId) as CheckpointRow[]
    await yieldToLoop()
    return rows.map(rowToCheckpoint)
  }

  public async listSessions(
    options: { readonly limit?: number } = {},
  ): Promise<ReadonlyArray<CheckpointSessionSummary>> {
    interface SummaryRow {
      readonly session_id: string
      readonly last_at: number
      readonly cnt: number
      readonly live_cnt: number
    }
    const rows = this.stmts.listSessionSummaries.all() as SummaryRow[]
    await yieldToLoop()
    const all = rows.map(
      (r): CheckpointSessionSummary => ({
        sessionId: r.session_id,
        lastCreatedAt: r.last_at,
        checkpointCount: r.cnt,
        hasInProgress: r.live_cnt > 0,
      }),
    )
    return options.limit === undefined ? all : all.slice(0, options.limit)
  }

  public async latestInProgress(
    options: {
      readonly sessionId?: string
      readonly minCreatedAt?: number
    } = {},
  ): Promise<AgentCheckpoint | undefined> {
    const minCreatedAt = options.minCreatedAt ?? 0
    const row = options.sessionId
      ? (this.stmts.latestInProgressBySession.get(options.sessionId, minCreatedAt) as
          | CheckpointRow
          | undefined)
      : (this.stmts.latestInProgress.get(minCreatedAt) as CheckpointRow | undefined)
    return row ? rowToCheckpoint(row) : undefined
  }

  public async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id)
    await yieldToLoop()
    return result.changes > 0
  }

  public async deleteSession(id: string): Promise<number> {
    const result = this.stmts.deleteBySessionId.run(id)
    await yieldToLoop()
    return result.changes
  }

  /** Close the underlying database. Tests should call this. */
  public async dispose(): Promise<void> {
    this.db.close()
    await yieldToLoop()
  }
}

/**
 * Yield to the event loop after a sync better-sqlite3 op so callers
 * see a real `await` hop instead of a fully synchronous return.
 * See {@link SqliteCheckpointStore} for the P23.11 (fix #55) rationale.
 */
const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve))
