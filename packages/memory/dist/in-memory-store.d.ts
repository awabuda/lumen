/**
 * `InMemoryStore` — a {@link BaseMemoryStore} backed by `Map`s.
 *
 * Why ship this in `@lumen/memory` and not just `@lumen/core`?
 *   - **Tests** that need a real `BaseMemoryStore` instance use this
 *     directly, without paying for a SQLite file.
 *   - **Ephemeral runs** (CI scratch agents, demo notebooks) want
 *     the same API but no disk footprint.
 *   - **Fallback.** A future `Agent` that opens a memory store and
 *     catches `SQLITE_CANTOPEN` can transparently swap in
 *     `InMemoryStore` and warn the user.
 *
 * # Concurrency
 *
 * JavaScript is single-threaded but `async` functions interleave.
 * To keep `appendMessage` strictly ordered, every mutation runs
 * inside a synchronous microtask boundary guarded by a private
 * `pending` promise chain. Two concurrent `appendMessage` calls
 * cannot interleave their `Map.set` calls — the second awaits
 * the first.
 *
 * # Eviction
 *
 * None. The in-memory store grows until `dispose()` is called.
 * That's intentional: the contract is "I am a fast, throwaway
 * store", not "I am a production cache". Production deployments
 * use {@link SqliteStore}.
 */
import { BaseMemoryStore, type MemoryQuery, type MemoryRecord, type MemorySearchResult, type SessionMessage, type SessionRecord } from '@lumen/core';
export declare class InMemoryStore extends BaseMemoryStore {
    readonly id = "memory";
    /** Records keyed by `MemoryRecord.id`. */
    private readonly records;
    /** Sessions keyed by `SessionRecord.id`. */
    private readonly sessions;
    /** Messages keyed by `SessionMessage.id`. */
    private readonly messages;
    /** Monotonic id for new messages. */
    private nextMessageId;
    /**
     * Promise chain that serialises all mutations. We never `await`
     * this in a public method's caller; we chain onto it so the
     * next mutation waits.
     */
    private pending;
    init(): Promise<void>;
    dispose(): Promise<void>;
    put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>;
    get(id: string): Promise<MemoryRecord | undefined>;
    delete(id: string): Promise<boolean>;
    search(query: MemoryQuery): Promise<ReadonlyArray<MemorySearchResult>>;
    /**
     * Pure (synchronous) search implementation shared by
     * `search()` and the {@link SqliteStore}-side test suite
     * (so both stores agree on ranking when FTS is not in play).
     *
     * Ranking is intentionally simple:
     *   - text  → 0 when substring present, 0 otherwise (we do not
     *     fake a TF-IDF; the SQLite store is the place for real
     *     text scoring via FTS5)
     *   - tags  → match count / query count
     *   - embedding → cosine similarity
     * Final score is the maximum of the matched dimensions, in [0, 1].
     */
    private searchSync;
    createSession(record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord>;
    getSession(id: string): Promise<SessionRecord | undefined>;
    listSessions(limit?: number): Promise<ReadonlyArray<SessionRecord>>;
    appendMessage(message: Omit<SessionMessage, 'id' | 'createdAt'>): Promise<SessionMessage>;
    getSessionMessages(sessionId: string, options?: {
        limit?: number;
        before?: number;
    }): Promise<ReadonlyArray<SessionMessage>>;
    prune(olderThanMs: number): Promise<number>;
    /**
     * Run `fn` after the previous mutation completes. We never
     * surface the `pending` chain to callers — every public method
     * resolves with the result of `fn` and silently waits for any
     * earlier in-flight mutation to finish.
     */
    private mutate;
}
//# sourceMappingURL=in-memory-store.d.ts.map