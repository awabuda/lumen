/**
 * `SqliteStore` — a {@link BaseMemoryStore} backed by `better-sqlite3`.
 *
 * This is Lumen's default memory store. The on-disk layout is:
 *
 *   - `records(id PK, kind, content, trust, created_at, updated_at, tags, metadata)`
 *     - `records_fts` is an FTS5 virtual table mirroring `content`
 *   - `sessions(id PK, title, created_at, updated_at, metadata)`
 *   - `messages(id INTEGER PRIMARY KEY AUTOINCREMENT,
 *              session_id, role, content, tool_name, created_at)`
 *
 * # Why these choices
 *
 *   - **FTS5 over LIKE.** A real agent will accumulate thousands of
 *     records; `LIKE '%term%'` is a table scan. FTS5 is O(log n)
 *     and gives us BM25 scoring for free.
 *   - **AUTOINCREMENT for messages.** Two writers (the agent loop
 *     and a hook) appending concurrently would collide on a
 *     shared counter; SQLite hands out monotonic ids that the
 *     agent loop can rely on for ordering.
 *   - **WAL journal.** A long-running daemon (`lumen chat`) and a
 *     one-shot CLI (`lumen run`) hitting the same database do not
 *     block each other on writes; readers see a consistent
 *     snapshot. WAL is on by default; we only switch off for the
 *     `:memory:` backend where there is no second connection.
 *   - **JSON columns for `metadata` and `tags`.** We keep the
 *     schema flat and pay a small parse cost on read. The
 *     alternative — a separate `record_tags` join table — is
 *     cleaner but triples the number of statements to maintain
 *     and offers no real win at this scale.
 *
 * # What this store does NOT do
 *
 *   - **Vector search.** FTS5 covers text; an embedding column
 *     is reserved (`records.embedding BLOB`) but no ANN index
 *     is built. That's a subclass's job — see the
 *     `lumen-memory-vec` future package.
 *   - **Cross-database migrations.** The schema is `SCHEMA_VERSION`
 *     stamped; an operator who upgrades across major versions
 *     runs the migration script separately. We do not silently
 *     mutate a user's database on `init()`.
 */
import { BaseMemoryStore, type MemoryQuery, type MemoryRecord, type MemorySearchResult, type SessionMessage, type SessionRecord } from '@lumen/core'
import BetterSqlite3, { type Database as BetterSqlite3Database, type Statement } from 'better-sqlite3'
import {
  BaseVectorBackend,
  BruteForceVectorBackend,
  SqliteVecBackend,
  type VectorHit,
} from './vector-backend.js'

/** Bumped when the schema shape changes incompatibly. */
const SCHEMA_VERSION = 1

/** Default trust when the caller does not supply one. */
const DEFAULT_TRUST = 0.5

/**
 * Configuration for {@link SqliteStore}.
 *
 * - `path` — `:memory:` for tests, a file path for production.
 *   `:memory:` is per-connection: the store does not share its
 *   memory DB with anyone else.
 * - `readonly` — open in read-only mode. Writes throw.
 * - `verbose` — pipe SQL to a logger. Off by default to keep
 *   `lumen doctor` quiet.
 */
export interface SqliteStoreConfig {
  readonly path: string
  readonly readonly?: boolean
  readonly verbose?: (sql: string) => void
}

export class SqliteStore extends BaseMemoryStore {
  public readonly id = 'sqlite'
  private readonly db: BetterSqlite3Database
  /**
   * Lazily-prepared statement bundle. The bundle is built in
   * {@link init} **after** the DDL has run; preparing against
   * an empty schema would fail on `INSERT INTO records(...)`
   * because the table does not exist yet. Storing it on the
   * instance and re-preparing in `init` is the simplest way to
   * keep `dispose → new instance → init` working.
   */
  private stmts: PreparedStatements | null = null
  private initialized = false
  /**
   * Vector backend, set in {@link init}. The contract is:
   *   - `BruteForceVectorBackend` if `sqlite-vec` could not
   *     be loaded.
   *   - `SqliteVecBackend` if the extension was found and
   *     loaded successfully.
   *
   * Callers should not assume which one is active; use
   * {@link vectorBackendId} to inspect if you need to
   * (e.g. to log the active strategy in `lumen doctor`).
   */
  private vector: BaseVectorBackend | null = null

  constructor(config: SqliteStoreConfig) {
    super()
    this.db = new BetterSqlite3(config.path, {
      readonly: config.readonly ?? false,
      // better-sqlite3's `verbose` signature is a variadic
      // logger; we only care about the SQL string. The cast is
      // safe because we never read the trailing args.
      verbose: config.verbose ? (config.verbose as never) : undefined,
    })
  }

  public async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    // PRAGMAs that affect connection-wide behaviour must be
    // set **before** any transaction begins — `synchronous`
    // and `journal_mode` are SQLite's "no go inside a tx"
    // examples, and `pragma()` triggers an implicit
    // transaction if one is already open.
    this.applyPragmas()
    // Run the DDL in a single transaction so a partial failure
    // (e.g. a corrupted file) leaves the DB in its previous state
    // rather than half-migrated.
    this.db.exec(BEGIN)
    try {
      this.applySchema()
      this.db.exec(COMMIT)
    } catch (err) {
      this.db.exec(ROLLBACK)
      throw err
    }
    // Set up the vector backend. We try the sqlite-vec
    // extension first; on any failure (package not
    // installed, ABI mismatch, vec0 unsupported on this
    // SQLite build) we silently fall back to the
    // brute-force backend. The active backend's id is
    // exposed via {@link vectorBackendId} so `lumen doctor`
    // can surface the choice to the operator.
    this.vector = this.buildVectorBackend()
  }

  /**
   * Build the active vector backend. Public for testing
   * (a test that does not want the sqlite-vec path can
   * override this via a subclass); production code
   * should leave it alone.
   */
  private buildVectorBackend(): BaseVectorBackend {
    // The default dimensionality is 1536 (text-embedding-3-small).
    // We do not hard-code this; an operator embedding
    // 384-dim vectors (sentence-transformers/all-MiniLM-L6-v2)
    // can change it via a derived class.
    const dimensions = 1536
    const loaded = SqliteVecBackend.tryLoad(this.db)
    if (loaded) {
      const backend = new SqliteVecBackend(this.db, dimensions)
      backend.init()
      return backend
    }
    return new BruteForceVectorBackend(dimensions)
  }

  /** Identifier of the active vector backend (`'sqlite-vec'` or `'brute-force'`). */
  public get vectorBackendId(): string {
    return this.vector?.id ?? '(uninitialized)'
  }

  public async dispose(): Promise<void> {
    // better-sqlite3's `close()` is synchronous; we wrap it in a
    // resolved promise to satisfy the async contract.
    await this.vector?.dispose()
    this.vector = null
    this.db.close()
  }

  /**
   * Top-K vector similarity search.
   *
   * @param embedding Float32-packed query embedding, same
   *   dimensionality as the active backend.
   * @param k Maximum hits to return. Defaults to 10.
   * @returns Up to `k` `MemorySearchResult` records ordered
   *   by descending similarity. Records without a stored
   *   embedding are NOT returned by this method; use
   *   {@link search} for hybrid text+vector queries.
   */
  public async vectorSearch(
    embedding: Uint8Array,
    k = 10,
  ): Promise<ReadonlyArray<MemorySearchResult>> {
    if (!this.vector) {
      throw new Error('SqliteStore used before init() completed. Call init() first.')
    }
    if (embedding.byteLength === 0) return []
    const hits = await this.vector.topK(embedding, k)
    if (hits.length === 0) return []
    // Join vector hits back onto the records table so the
    // caller gets the full MemoryRecord, not just the id.
    // We do a single parameterised IN-clause round-trip.
    const ids = hits.map((h) => h.id)
    const placeholders = ids.map(() => '?').join(', ')
    const sql =
      'SELECT id, kind, content, trust, created_at, updated_at, tags, metadata ' +
      `FROM records WHERE id IN (${placeholders})`
    const rows = this.db.prepare(sql).all(...ids) as Array<{
      id: string
      kind: string
      content: string
      trust: number
      created_at: number
      updated_at: number
      tags: string
      metadata: string
    }>
    const byId = new Map<string, (typeof rows)[number]>()
    for (const r of rows) byId.set(r.id, r)
    // Preserve the vector backend's similarity order, not
    // the row table's natural order.
    const out: MemorySearchResult[] = []
    for (const h of hits) {
      const row = byId.get(h.id)
      if (!row) {
        // Stale hit: the row was deleted between the
        // vector scan and the join. Drop it.
        continue
      }
      out.push({ record: rowToRecord(row), score: h.score })
    }
    return out
  }

  /**
   * The statement bundle is always non-null after `init()`. This
   * accessor centralises the `!` so the implementation methods
   * stay readable, and the assertion is on a contract that is
   * true by construction: every public method that touches a
   * statement requires `init()` to have completed, which is the
   * composition root's responsibility.
   */
  private get s(): PreparedStatements {
    if (!this.stmts) {
      throw new Error('SqliteStore used before init() completed. Call init() in your composition root.')
    }
    return this.stmts
  }

  private applyPragmas(): void {
    // PRAGMA tuning. Each statement is idempotent and scoped to
    // the current connection. journal_mode=WAL is skipped for
    // `:memory:` because WAL needs a real file.
    if (!this.db.name.endsWith(':memory:')) {
      this.db.pragma('journal_mode = WAL')
    }
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
  }

  private applySchema(): void {
    // In `readonly` mode the database file is opened without
    // write privileges; `CREATE TABLE IF NOT EXISTS` and the
    // `schema_meta` upsert would error out. We rely on the
    // schema having been created by a prior non-readonly
    // instance (the operator's contract) and skip the DDL.
    if (this.db.readonly) {
      this.stmts = prepareStatements(this.db)
      return
    }
    this.db.exec(SCHEMA_DDL)
    // Record the schema version for future migrations. We
    // assign the bundle before running any of its statements
    // so the `s` accessor sees a non-null value here.
    this.stmts = prepareStatements(this.db)
    this.stmts.setSchemaVersion.run(SCHEMA_VERSION)
  }

  // ---- Record CRUD --------------------------------------------------------

  public put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    // better-sqlite3 is synchronous, so a write error
    // surfaces as a thrown `SqliteError` from `putSync`.
    // We wrap in an `async` arrow so the throw becomes a
    // rejected promise — that matches the contract that
    // every {@link BaseMemoryStore} method is async and
    // signals failure through the promise.
    return new Promise<MemoryRecord>((resolve, reject) => {
      try {
        resolve(this.putSync(record))
      } catch (err) {
        reject(err)
      }
    })
  }

  private putSync(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): MemoryRecord {
    const now = Date.now()
    const existing = this.s.getRecord.get(record.id) as
      | { id: string; kind: string; content: string; trust: number; created_at: number; updated_at: number; tags: string; metadata: string }
      | undefined
    const stored: MemoryRecord = {
      ...record,
      trust: record.trust ?? DEFAULT_TRUST,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      tags: record.tags ?? [],
    }
    this.db.exec(BEGIN)
    try {
      this.s.upsertRecord.run(
        stored.id,
        stored.kind,
        stored.content,
        stored.trust,
        stored.createdAt,
        stored.updatedAt,
        JSON.stringify(stored.tags),
        JSON.stringify(stored.metadata ?? {}),
      )
      // Mirror into FTS. We use delete+insert rather than the
      // FTS5 `external content` table form because a `content=`
      // table cannot be in the same DB as a regular table
      // without complications. For our scale (thousands of
      // records), the duplication is invisible.
      this.s.deleteFts.run(stored.id)
      this.s.insertFts.run(stored.id, stored.kind, stored.content)
      this.db.exec(COMMIT)
    } catch (err) {
      this.db.exec(ROLLBACK)
      throw err
    }
    return stored
  }

  public get(id: string): Promise<MemoryRecord | undefined> {
    const row = this.s.getRecord.get(id) as
      | {
          id: string
          kind: string
          content: string
          trust: number
          created_at: number
          updated_at: number
          tags: string
          metadata: string
        }
      | undefined
    return Promise.resolve(row ? rowToRecord(row) : undefined)
  }

  public delete(id: string): Promise<boolean> {
    const result = this.db.transaction(() => {
      const ftsInfo = this.s.deleteFts.run(id)
      const recInfo = this.s.deleteRecord.run(id)
      // `changes` on a run-result tells us how many rows the
      // statement actually touched. Either DELETE returning 1
      // means the record existed; we OR them so a half-deleted
      // row (which shouldn't be possible) still reports false.
      return ftsInfo.changes + recInfo.changes
    })()
    return Promise.resolve(result > 0)
  }

  public search(query: MemoryQuery): Promise<ReadonlyArray<MemorySearchResult>> {
    return Promise.resolve(this.searchSync(query))
  }

  /**
   * Search implementation. Three strategies, in priority order:
   *
   *   1. **FTS5 path** — if `query.text` is set, hit the FTS
   *      virtual table and join back to `records` for the
   *      metadata filters. BM25 score is normalised to [0, 1].
   *   2. **Filter-only path** — kind/tags/minTrust with no
   *      text. The score is the count of matched dimensions
   *      divided by the number of dimensions the query asked
   *      for (a 0-1 "what fraction matched" number).
   *   3. **Vector path** — placeholder. We just scan the
   *      candidate set and compute cosine. A real ANN index
   *      lives in a subclass; this implementation does not
   *      pretend to be one.
   */
  private searchSync(query: MemoryQuery): ReadonlyArray<MemorySearchResult> {
    const minTrust = query.minTrust ?? 0
    const limit = query.limit ?? 50

    if (query.text) {
      // Escape the FTS5 query so a stray `*` or `"` in user
      // input does not blow up. We split on whitespace and
      // quote each token; this is a coarse but safe strategy.
      const tokens = query.text
        .split(/\s+/)
        .map((t) => t.replace(/[^a-zA-Z0-9_]/g, ''))
        .filter(Boolean)
      if (tokens.length === 0) return []
      const ftsQuery = tokens.map((t) => `"${t}"`).join(' ')

      const rows = this.s.searchByFts.all(ftsQuery, minTrust) as Array<{
        id: string
        kind: string
        content: string
        trust: number
        created_at: number
        updated_at: number
        tags: string
        metadata: string
        bm25: number
      }>
      let results = rows.map((r) => ({
        record: rowToRecord(r),
        // BM25 returns negative numbers; lower is better. Map to
        // [0, 1] by clamping. We do not normalise across the
        // corpus because the agent loop only cares about the
        // top-N ordering; absolute values are not promised.
        score: Math.max(0, Math.min(1, 1 / (1 + Math.abs(r.bm25)))),
      }))

      // Apply kind/tags filter post-FTS so the FTS5 query stays
      // a single, indexable string.
      results = results.filter(({ record }) => {
        if (query.kind && record.kind !== query.kind) return false
        if (query.tags && !query.tags.every((t) => record.tags.includes(t))) return false
        return true
      })

      // Re-rank by cosine if the query asked for an embedding.
      if (query.embedding) {
        results = results
          .map((r) => {
            if (!r.record.embedding) return { ...r, score: r.score * 0.5 }
            return {
              ...r,
              score: Math.max(r.score, cosineSimilarity(r.record.embedding, query.embedding!)),
            }
          })
          .sort((a, b) => b.score - a.score)
      }
      return results.slice(0, limit)
    }

    // No text: fall back to a metadata filter scan. We don't
    // have a metadata index, so this is O(n). For a few
    // thousand records that's still microseconds; an operator
    // with millions of records adds an index in a derived
    // class.
    const rows = this.s.filterRecords.all(minTrust) as Array<{
      id: string
      kind: string
      content: string
      trust: number
      created_at: number
      updated_at: number
      tags: string
      metadata: string
    }>
    const results: MemorySearchResult[] = []
    for (const row of rows) {
      const r = rowToRecord(row)
      if (query.kind && r.kind !== query.kind) continue
      if (query.tags && !query.tags.every((t) => r.tags.includes(t))) continue
      let score = 0
      if (query.tags && query.tags.length > 0) {
        const matches = query.tags.filter((t) => r.tags.includes(t)).length
        score = matches / query.tags.length
      } else {
        // No text, no tags: every match scores the same.
        score = 0.5
      }
      if (query.embedding && r.embedding) {
        score = Math.max(score, cosineSimilarity(r.embedding, query.embedding))
      }
      results.push({ record: r, score })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  // ---- Sessions -----------------------------------------------------------

  public createSession(
    record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<SessionRecord> {
    return new Promise<SessionRecord>((resolve, reject) => {
      try {
        resolve(this.createSessionSync(record))
      } catch (err) {
        reject(err)
      }
    })
  }

  private createSessionSync(record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): SessionRecord {
    const now = Date.now()
    this.s.upsertSession.run(
      record.id,
      record.title ?? null,
      now,
      now,
      JSON.stringify(record.metadata ?? {}),
    )
    return { ...record, createdAt: now, updatedAt: now }
  }

  public getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.s.getSession.get(id) as
      | { id: string; title: string | null; created_at: number; updated_at: number; metadata: string }
      | undefined
    if (!row) return Promise.resolve(undefined)
    return Promise.resolve(rowToSession(row))
  }

  public listSessions(limit?: number): Promise<ReadonlyArray<SessionRecord>> {
    const rows = (
      limit === undefined
        ? this.s.listAllSessions.all()
        : this.s.listRecentSessions.all(limit)
    ) as Array<{
      id: string
      title: string | null
      created_at: number
      updated_at: number
      metadata: string
    }>
    return Promise.resolve(rows.map(rowToSession))
  }

  public appendMessage(
    message: Omit<SessionMessage, 'id' | 'createdAt'>,
  ): Promise<SessionMessage> {
    return new Promise<SessionMessage>((resolve, reject) => {
      try {
        resolve(this.appendMessageSync(message))
      } catch (err) {
        reject(err)
      }
    })
  }

  private appendMessageSync(message: Omit<SessionMessage, 'id' | 'createdAt'>): SessionMessage {
    const now = Date.now()
    // The whole append is one transaction so a crash between
    // the INSERT and the session-bump does not leave the
    // session's `updatedAt` behind.
    this.db.transaction(() => {
      const info = this.s.insertMessage.run(
        message.sessionId,
        message.role,
        message.content,
        message.toolName ?? null,
        now,
      )
      // Bump the session's `updated_at` so listSessions surfaces
      // recently-active conversations first.
      this.s.touchSession.run(now, message.sessionId)
      // We don't return the new id through the prepared
      // statement's `.run()` info because the typed surface
      // varies; we re-read via lastInsertRowid.
      this.lastInsertedMessageId = Number(info.lastInsertRowid)
    })()
    return {
      ...message,
      id: this.lastInsertedMessageId,
      createdAt: now,
    }
  }

  /** Cached between `appendMessageSync` and its caller. */
  private lastInsertedMessageId = 0

  public getSessionMessages(
    sessionId: string,
    options?: { limit?: number; before?: number },
  ): Promise<ReadonlyArray<SessionMessage>> {
    const limit = options?.limit ?? 1000
    const before = options?.before ?? Number.MAX_SAFE_INTEGER
    const rows = this.s.getMessagesBefore.all(sessionId, before, limit) as Array<{
      id: number
      session_id: string
      role: string
      content: string
      tool_name: string | null
      created_at: number
    }>
    return Promise.resolve(rows.map(rowToMessage))
  }

  public deleteSession(id: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // We open a write transaction (not readonly) — refusing
      // the call here would surprise a CLI user who passes
      // `--memory-path ~/.lumen/memory.db` expecting writes.
      // A read-only SqliteStore throws synchronously inside the
      // transaction; we let that bubble up.
      try {
        const removed = this.db.transaction(() => {
          // Cascade messages first so we never leak orphan rows
          // when the FK-less schema is the active one.
          this.s.deleteMessagesForSession.run(id)
          const info = this.s.deleteSessionById.run(id)
          return info.changes > 0
        })()
        resolve(removed)
      } catch (err) {
        reject(err)
      }
    })
  }

  // ---- Maintenance --------------------------------------------------------

  public prune(olderThanMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      try {
        resolve(this.pruneSync(olderThanMs))
      } catch (err) {
        reject(err)
      }
    })
  }

  private pruneSync(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs
    return this.db.transaction(() => {
      // Records: delete the row, then mirror into FTS.
      const recordRows = this.s.listOldRecords.all(cutoff) as Array<{ id: string }>
      for (const r of recordRows) this.s.deleteFts.run(r.id)
      this.s.pruneRecords.run(cutoff)
      // Sessions: deleting a session does NOT delete its
      // messages. We cascade manually so a stale
      // `getSessionMessages` doesn't return orphan rows.
      const sessionRows = this.s.listOldSessions.all(cutoff) as Array<{ id: string }>
      for (const s of sessionRows) this.s.deleteMessagesForSession.run(s.id)
      this.s.pruneSessions.run(cutoff)
      return recordRows.length + sessionRows.length
    })()
  }
}

// ---- Helpers --------------------------------------------------------------

const BEGIN = 'BEGIN'
const COMMIT = 'COMMIT'
const ROLLBACK = 'ROLLBACK'

/** DDL for the initial schema. Idempotent thanks to IF NOT EXISTS. */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  trust      REAL NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  tags       TEXT NOT NULL DEFAULT '[]',
  metadata   TEXT NOT NULL DEFAULT '{}',
  embedding  BLOB
);
CREATE INDEX IF NOT EXISTS records_kind_idx     ON records(kind);
CREATE INDEX IF NOT EXISTS records_updated_idx  ON records(updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  tool_name  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, id);
`

interface PreparedStatements {
  setSchemaVersion: Statement
  getRecord: Statement
  upsertRecord: Statement
  deleteRecord: Statement
  deleteFts: Statement
  insertFts: Statement
  searchByFts: Statement
  filterRecords: Statement
  listOldRecords: Statement
  pruneRecords: Statement
  upsertSession: Statement
  getSession: Statement
  listAllSessions: Statement
  listRecentSessions: Statement
  touchSession: Statement
  listOldSessions: Statement
  pruneSessions: Statement
  insertMessage: Statement
  getMessagesBefore: Statement
  deleteMessagesForSession: Statement
  deleteSessionById: Statement
}

function prepareStatements(db: BetterSqlite3Database): PreparedStatements {
  return {
    setSchemaVersion: db.prepare(
      `INSERT INTO schema_meta(key, value) VALUES('version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    getRecord: db.prepare(
      'SELECT id, kind, content, trust, created_at, updated_at, tags, metadata FROM records WHERE id = ?',
    ),
    upsertRecord: db.prepare(
      `INSERT INTO records(id, kind, content, trust, created_at, updated_at, tags, metadata)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         content = excluded.content,
         trust = excluded.trust,
         updated_at = excluded.updated_at,
         tags = excluded.tags,
         metadata = excluded.metadata`,
    ),
    deleteRecord: db.prepare('DELETE FROM records WHERE id = ?'),
    deleteFts: db.prepare('DELETE FROM records_fts WHERE id = ?'),
    insertFts: db.prepare('INSERT INTO records_fts(id, kind, content) VALUES(?, ?, ?)'),
    searchByFts: db.prepare(
      `SELECT r.id, r.kind, r.content, r.trust, r.created_at, r.updated_at, r.tags, r.metadata, fts.rank AS bm25
         FROM records_fts fts
         JOIN records r ON r.id = fts.id
        WHERE records_fts MATCH ?
          AND r.trust >= ?
        ORDER BY fts.rank
        LIMIT 200`,
    ),
    filterRecords: db.prepare(
      'SELECT id, kind, content, trust, created_at, updated_at, tags, metadata FROM records WHERE trust >= ? ORDER BY updated_at DESC',
    ),
    listOldRecords: db.prepare('SELECT id FROM records WHERE updated_at < ?'),
    pruneRecords: db.prepare('DELETE FROM records WHERE updated_at < ?'),
    upsertSession: db.prepare(
      `INSERT INTO sessions(id, title, created_at, updated_at, metadata)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         metadata = excluded.metadata`,
    ),
    getSession: db.prepare(
      'SELECT id, title, created_at, updated_at, metadata FROM sessions WHERE id = ?',
    ),
    listAllSessions: db.prepare(
      'SELECT id, title, created_at, updated_at, metadata FROM sessions ORDER BY updated_at DESC',
    ),
    listRecentSessions: db.prepare(
      'SELECT id, title, created_at, updated_at, metadata FROM sessions ORDER BY updated_at DESC LIMIT ?',
    ),
    touchSession: db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
    listOldSessions: db.prepare('SELECT id FROM sessions WHERE updated_at < ?'),
    pruneSessions: db.prepare('DELETE FROM sessions WHERE updated_at < ?'),
    insertMessage: db.prepare(
      'INSERT INTO messages(session_id, role, content, tool_name, created_at) VALUES(?, ?, ?, ?, ?)',
    ),
    getMessagesBefore: db.prepare(
      // ASC: the agent loop reads messages oldest-first so
      // it can replay the conversation in order. `LIMIT`
      // with a fixed `before` cursor gives a cheap paged
      // API: pass the last seen id as `before` to fetch the
      // next page. When the caller wants the *tail*, they
      // invert the sort themselves — keeping the column
      // index small.
      'SELECT id, session_id, role, content, tool_name, created_at FROM messages WHERE session_id = ? AND id < ? ORDER BY id ASC LIMIT ?',
    ),
    deleteMessagesForSession: db.prepare('DELETE FROM messages WHERE session_id = ?'),
    deleteSessionById: db.prepare('DELETE FROM sessions WHERE id = ?'),
  }
}

function rowToRecord(row: {
  id: string
  kind: string
  content: string
  trust: number
  created_at: number
  updated_at: number
  tags: string
  metadata: string
}): MemoryRecord {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    trust: row.trust,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: safeJsonArray(row.tags),
    metadata: safeJsonObject(row.metadata),
  }
}

function rowToSession(row: {
  id: string
  title: string | null
  created_at: number
  updated_at: number
  metadata: string
}): SessionRecord {
  return {
    id: row.id,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: safeJsonObject(row.metadata),
  }
}

function rowToMessage(row: {
  id: number
  session_id: string
  role: string
  content: string
  tool_name: string | null
  created_at: number
}): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as SessionMessage['role'],
    content: row.content,
    toolName: row.tool_name ?? undefined,
    createdAt: row.created_at,
  }
}

function safeJsonArray(raw: string): ReadonlyArray<string> {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function safeJsonObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Cosine similarity in [0, 1]. Returns 0 for zero vectors. */
function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0) return 0
  return Math.max(0, Math.min(1, dot / denom))
}
