/**
 * Memory contract — the persistence boundary for the agent.
 *
 * The base interface is intentionally tiny. Implementations may be:
 *   - in-memory (for tests)
 *   - SQLite-backed (the default)
 *   - Redis, Postgres, or anything else
 *
 * The base contract is NOT a query DSL — it exposes a small set of methods
 * that cover 95% of agent needs. Specialised queries live in subclasses.
 *
 * The contract is also intentionally split into two concerns:
 *   1. {@link BaseMemoryStore} — durable records (facts, sessions)
 *   2. (future) Embedding index — separate, optional
 *
 * The agent uses both; subclasses can implement them in one class.
 */

/** A persisted memory record. Generic — implementations decide shape. */
export interface MemoryRecord {
  readonly id: string
  /** The kind of record (e.g. "fact", "session-message", "user-pref"). */
  readonly kind: string
  /** Free-form content. Implementations may index this. */
  readonly content: string
  /** Structured metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** Embedding (if the store supports vector search). */
  readonly embedding?: ReadonlyArray<number>
  /** When the record was created (epoch ms). */
  readonly createdAt: number
  /** When the record was last updated (epoch ms). */
  readonly updatedAt: number
  /** Trust score, 0-1. Used for confidence-based eviction. */
  readonly trust: number
  /** Free-form tags for filtering. */
  readonly tags: ReadonlyArray<string>
}

export interface MemoryQuery {
  /** Filter by kind. */
  readonly kind?: string
  /** Filter by tag (all must match). */
  readonly tags?: ReadonlyArray<string>
  /** Full-text query (optional). */
  readonly text?: string
  /** Vector query (optional). */
  readonly embedding?: ReadonlyArray<number>
  /** Maximum results to return. */
  readonly limit?: number
  /** Minimum trust score. */
  readonly minTrust?: number
}

export interface MemorySearchResult {
  readonly record: MemoryRecord
  /** Relevance score (0-1, higher is more relevant). */
  readonly score: number
}

export interface SessionRecord {
  readonly id: string
  readonly title?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SessionMessage {
  readonly id: number
  readonly sessionId: string
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  readonly toolName?: string
  readonly createdAt: number
}

/**
 * Abstract base for memory stores.
 *
 * Implementations MUST be safe to call from multiple async contexts
 * concurrently. The base contract does not promise transactions across
 * methods — if you need atomicity, expose a `transaction()` helper in a
 * subclass.
 */
export abstract class BaseMemoryStore {
  /** Stable identifier for this store (e.g. "sqlite", "memory", "redis"). */
  public abstract readonly id: string

  /** Lifecycle. Subclasses may perform file/network setup. */
  public abstract init(): Promise<void>

  /** Lifecycle. Subclasses MUST release all resources here. */
  public abstract dispose(): Promise<void>

  // ---- Record CRUD --------------------------------------------------------

  public abstract put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord>

  public abstract get(id: string): Promise<MemoryRecord | undefined>

  public abstract delete(id: string): Promise<boolean>

  public abstract search(query: MemoryQuery): Promise<ReadonlyArray<MemorySearchResult>>

  // ---- Sessions -----------------------------------------------------------

  public abstract createSession(record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): Promise<SessionRecord>

  public abstract getSession(id: string): Promise<SessionRecord | undefined>

  public abstract listSessions(limit?: number): Promise<ReadonlyArray<SessionRecord>>

  public abstract appendMessage(message: Omit<SessionMessage, 'id' | 'createdAt'>): Promise<SessionMessage>

  public abstract getSessionMessages(
    sessionId: string,
    options?: { limit?: number; before?: number },
  ): Promise<ReadonlyArray<SessionMessage>>

  // ---- Maintenance --------------------------------------------------------

  /** Prune records older than `olderThanMs`. Returns count removed. */
  public abstract prune(olderThanMs: number): Promise<number>
}
