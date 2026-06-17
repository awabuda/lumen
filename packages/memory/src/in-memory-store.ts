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
import {
  BaseMemoryStore,
  type MemoryQuery,
  type MemoryRecord,
  type MemorySearchResult,
  type SessionMessage,
  type SessionRecord,
} from '@lumen/core'
import { MemoryQuerySchema, parseOrThrow } from './schemas.js'

/** Comparator for `getSessionMessages`: oldest first. */
function byIdAsc(a: SessionMessage, b: SessionMessage): number {
  return a.id - b.id
}

/** Default trust when the caller does not supply one. */
const DEFAULT_TRUST = 0.5

export class InMemoryStore extends BaseMemoryStore {
  public readonly id = 'memory'

  /** Records keyed by `MemoryRecord.id`. */
  private readonly records = new Map<string, MemoryRecord>()
  /** Sessions keyed by `SessionRecord.id`. */
  private readonly sessions = new Map<string, SessionRecord>()
  /** Messages keyed by `SessionMessage.id`. */
  private readonly messages = new Map<number, SessionMessage>()
  /** Monotonic id for new messages. */
  private nextMessageId = 1
  /**
   * Promise chain that serialises all mutations. We never `await`
   * this in a public method's caller; we chain onto it so the
   * next mutation waits.
   */
  private pending: Promise<void> = Promise.resolve()

  public async init(): Promise<void> {
    // No-op. The store is ready as soon as it is constructed.
  }

  public async dispose(): Promise<void> {
    // Drop everything so a disposed store cannot be reused.
    this.records.clear()
    this.sessions.clear()
    this.messages.clear()
    this.nextMessageId = 1
    this.pending = Promise.resolve()
  }

  public put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    return this.mutate(async () => {
      const now = Date.now()
      const existing = this.records.get(record.id)
      const stored: MemoryRecord = {
        ...record,
        // Trust the caller's `trust` if provided, else default.
        trust: record.trust ?? DEFAULT_TRUST,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        tags: record.tags ?? [],
      }
      this.records.set(stored.id, stored)
      return stored
    })
  }

  public get(id: string): Promise<MemoryRecord | undefined> {
    return Promise.resolve(this.records.get(id))
  }

  public delete(id: string): Promise<boolean> {
    return this.mutate(async () => this.records.delete(id))
  }

  public search(query: MemoryQuery): Promise<ReadonlyArray<MemorySearchResult>> {
    // Validate at the boundary. A typo'd `minTrust: 1.5` or a
    // negative `limit` should surface as a typed `ValidationError`
    // here, not as a silently-empty result set further down.
    const validated = parseOrThrow(MemoryQuerySchema, query, 'query')
    return Promise.resolve(this.searchSync(validated as MemoryQuery))
  }

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
  private searchSync(query: MemoryQuery): ReadonlyArray<MemorySearchResult> {
    const minTrust = query.minTrust ?? 0
    const all: MemoryRecord[] = []
    for (const r of this.records.values()) {
      if (query.kind && r.kind !== query.kind) continue
      if (r.trust < minTrust) continue
      if (query.tags && !query.tags.every((t) => r.tags.includes(t))) continue
      all.push(r)
    }
    const scored: MemorySearchResult[] = []
    for (const r of all) {
      let score = 0
      if (query.text) {
        const needle = query.text.toLowerCase()
        if (r.content.toLowerCase().includes(needle)) score = Math.max(score, 0.8)
      }
      if (query.embedding && r.embedding) {
        score = Math.max(score, cosineSimilarity(r.embedding, query.embedding))
      }
      if (query.tags && query.tags.length > 0) {
        const matches = query.tags.filter((t) => r.tags.includes(t)).length
        score = Math.max(score, matches / query.tags.length)
      }
      // A `text`-only query must not surface rows whose text
      // did not match. We treat a positive `text` as a hard
      // filter; rows with score 0 are dropped before the
      // limit. The SQLite store enforces the same rule in
      // SQL, so both backends agree.
      if (query.text && score === 0) continue
      scored.push({ record: r, score })
    }
    scored.sort((a, b) => b.score - a.score)
    const limit = query.limit ?? 50
    return scored.slice(0, limit)
  }

  public createSession(
    record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<SessionRecord> {
    return this.mutate(async () => {
      const now = Date.now()
      const stored: SessionRecord = {
        ...record,
        createdAt: now,
        updatedAt: now,
      }
      this.sessions.set(stored.id, stored)
      return stored
    })
  }

  public getSession(id: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.sessions.get(id))
  }

  public listSessions(limit?: number): Promise<ReadonlyArray<SessionRecord>> {
    const all = Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt)
    return Promise.resolve(limit === undefined ? all : all.slice(0, limit))
  }

  public appendMessage(message: Omit<SessionMessage, 'id' | 'createdAt'>): Promise<SessionMessage> {
    return this.mutate(async () => {
      const id = this.nextMessageId++
      const stored: SessionMessage = {
        ...message,
        id,
        createdAt: Date.now(),
      }
      this.messages.set(id, stored)
      // Bump the session's `updatedAt` so listSessions is meaningful
      // even when the agent only appends messages.
      const session = this.sessions.get(stored.sessionId)
      if (session) {
        this.sessions.set(session.id, { ...session, updatedAt: stored.createdAt })
      }
      return stored
    })
  }

  public getSessionMessages(
    sessionId: string,
    options?: { limit?: number; before?: number },
  ): Promise<ReadonlyArray<SessionMessage>> {
    const filtered: SessionMessage[] = []
    for (const m of this.messages.values()) {
      if (m.sessionId !== sessionId) continue
      if (options?.before !== undefined && m.id >= options.before) continue
      filtered.push(m)
    }
    filtered.sort(byIdAsc)
    const out = options?.limit === undefined ? filtered : filtered.slice(-options.limit) // last N in chronological order
    return Promise.resolve(out)
  }

  public deleteSession(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const hadSession = this.sessions.delete(id)
      if (!hadSession) return false
      // Cascade: drop every message attached to the deleted
      // session so a subsequent `getSessionMessages` doesn't
      // return orphan rows.
      for (const [mid, m] of this.messages) {
        if (m.sessionId === id) this.messages.delete(mid)
      }
      return true
    })
  }

  public prune(olderThanMs: number): Promise<number> {
    return this.mutate(async () => {
      const cutoff = Date.now() - olderThanMs
      let removed = 0
      for (const [id, r] of this.records) {
        if (r.updatedAt < cutoff) {
          this.records.delete(id)
          removed += 1
        }
      }
      for (const [id, s] of this.sessions) {
        if (s.updatedAt < cutoff) {
          this.sessions.delete(id)
          removed += 1
        }
      }
      // We deliberately do NOT prune individual messages: the
      // session-level cutoff is the operator's knob. If you need
      // per-message TTL, build a derived store.
      return removed
    })
  }

  /**
   * Run `fn` after the previous mutation completes. We never
   * surface the `pending` chain to callers — every public method
   * resolves with the result of `fn` and silently waits for any
   * earlier in-flight mutation to finish.
   */
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.pending.then(fn)
    // Swallow rejections on the chain itself so one failure
    // doesn't poison the next mutation's wait.
    this.pending = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

/** Cosine similarity in [-1, 1]. Returns 0 for zero vectors. */
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
  // Clamp because floating-point drift can push values like
  // 1.0000000002 outside [-1, 1] and the agent loop's score
  // consumers will treat anything > 1 as a bug.
  return Math.max(0, Math.min(1, dot / denom))
}
