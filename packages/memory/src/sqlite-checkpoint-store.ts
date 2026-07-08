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

import BetterSqlite3 from 'better-sqlite3'
import type { Database, Statement } from 'better-sqlite3'
import * as path from 'node:path'

import type { AgentCheckpoint, BaseCheckpointStore, Message } from '@lumen/core'

const CHECKPOINTS_DDL = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  iterations    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  label         TEXT,
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
  return row.label ? { ...base, label: row.label } : base
}

const checkpointToRow = (cp: AgentCheckpoint): CheckpointRow => ({
  id: cp.id,
  session_id: cp.sessionId,
  iterations: cp.iterations,
  created_at: cp.createdAt,
  label: cp.label ?? null,
  messages_json: JSON.stringify(cp.messages),
})

interface PreparedCheckpointStatements {
  insert: Statement
  get: Statement
  listBySession: Statement
  delete: Statement
}

const prepareStatements = (db: Database): PreparedCheckpointStatements => ({
  insert: db.prepare(
    `INSERT INTO checkpoints (id, session_id, iterations, created_at, label, messages_json)
     VALUES (@id, @session_id, @iterations, @created_at, @label, @messages_json)
     ON CONFLICT(id) DO UPDATE SET
       session_id    = excluded.session_id,
       iterations    = excluded.iterations,
       created_at    = excluded.created_at,
       label         = excluded.label,
       messages_json = excluded.messages_json`,
  ),
  get: db.prepare(`SELECT * FROM checkpoints WHERE id = ?`),
  listBySession: db.prepare(
    `SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC`,
  ),
  delete: db.prepare(`DELETE FROM checkpoints WHERE id = ?`),
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
    this.db = new BetterSqlite3(resolved)
    if (!this.db.name.endsWith(':memory:')) {
      this.db.pragma('journal_mode = WAL')
    }
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.exec(CHECKPOINTS_DDL)
    this.stmts = prepareStatements(this.db)
  }

  public async save(checkpoint: AgentCheckpoint): Promise<AgentCheckpoint> {
    this.stmts.insert.run(checkpointToRow(checkpoint))
    return checkpoint
  }

  public async get(id: string): Promise<AgentCheckpoint | undefined> {
    const row = this.stmts.get.get(id) as CheckpointRow | undefined
    return row ? rowToCheckpoint(row) : undefined
  }

  public async list(sessionId: string): Promise<ReadonlyArray<AgentCheckpoint>> {
    const rows = this.stmts.listBySession.all(sessionId) as CheckpointRow[]
    return rows.map(rowToCheckpoint)
  }

  public async delete(id: string): Promise<boolean> {
    const result = this.stmts.delete.run(id)
    return result.changes > 0
  }

  /** Close the underlying database. Tests should call this. */
  public async dispose(): Promise<void> {
    this.db.close()
  }
}
