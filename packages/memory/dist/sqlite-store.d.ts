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
import { BaseMemoryStore, type MemoryQuery, type MemoryRecord, type MemorySearchResult, type SessionMessage, type SessionRecord } from '@lumen/core';
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
    readonly path: string;
    readonly readonly?: boolean;
    readonly verbose?: (sql: string) => void;
}
export declare class SqliteStore extends BaseMemoryStore {
    readonly id = "sqlite";
    private readonly db;
    /**
     * Lazily-prepared statement bundle. The bundle is built in
     * {@link init} **after** the DDL has run; preparing against
     * an empty schema would fail on `INSERT INTO records(...)`
     * because the table does not exist yet. Storing it on the
     * instance and re-preparing in `init` is the simplest way to
     * keep `dispose → new instance → init` working.
     */
    private stmts;
    private initialized;
    constructor(config: SqliteStoreConfig);
    init(): Promise<void>;
    dispose(): Promise<void>;
    /**
     * The statement bundle is always non-null after `init()`. This
     * accessor centralises the `!` so the implementation methods
     * stay readable, and the assertion is on a contract that is
     * true by construction: every public method that touches a
     * statement requires `init()` to have completed, which is the
     * composition root's responsibility.
     */
    private get s();
    private applyPragmas;
    private applySchema;
    put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>;
    private putSync;
    get(id: string): Promise<MemoryRecord | undefined>;
    delete(id: string): Promise<boolean>;
    search(query: MemoryQuery): Promise<ReadonlyArray<MemorySearchResult>>;
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
    private searchSync;
    createSession(record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord>;
    private createSessionSync;
    getSession(id: string): Promise<SessionRecord | undefined>;
    listSessions(limit?: number): Promise<ReadonlyArray<SessionRecord>>;
    appendMessage(message: Omit<SessionMessage, 'id' | 'createdAt'>): Promise<SessionMessage>;
    private appendMessageSync;
    /** Cached between `appendMessageSync` and its caller. */
    private lastInsertedMessageId;
    getSessionMessages(sessionId: string, options?: {
        limit?: number;
        before?: number;
    }): Promise<ReadonlyArray<SessionMessage>>;
    prune(olderThanMs: number): Promise<number>;
    private pruneSync;
}
//# sourceMappingURL=sqlite-store.d.ts.map