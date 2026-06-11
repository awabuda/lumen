/**
 * @lumen/memory — concrete memory stores for the Lumen agent.
 *
 * This package ships two {@link BaseMemoryStore} implementations
 * and re-exports the contract from `@lumen/core`:
 *
 *   - {@link InMemoryStore} — Map-backed, no disk, for tests and
 *     ephemeral agents.
 *   - {@link SqliteStore} — `better-sqlite3`-backed with FTS5,
 *     WAL journal, and prepared-statement caching. The default
 *     for the CLI and any agent that needs persistence across
 *     process restarts.
 *
 * Quick start:
 *
 * ```ts
 * import { SqliteStore } from '@lumen/memory'
 * import { Agent } from '@lumen/core'
 *
 * const store = new SqliteStore({ path: '~/.lumen/memory.db' })
 * await store.init()
 *
 * const agent = new Agent({ provider, tools, memory: store })
 * ```
 *
 * Both stores are safe to share across concurrent async
 * operations; the SQLite store additionally supports cross-process
 * access (e.g. a background indexer) via WAL mode.
 */

export {
  type MemoryQuery,
  type MemoryRecord,
  type MemorySearchResult,
  type SessionMessage,
  type SessionRecord,
  BaseMemoryStore,
} from './base.js'

export { InMemoryStore } from './in-memory-store.js'
export { SqliteStore, type SqliteStoreConfig } from './sqlite-store.js'
export {
  BaseVectorBackend,
  BruteForceVectorBackend,
  SqliteVecBackend,
  type SqliteDatabase,
  type VectorHit,
  type VectorPoint,
} from './vector-backend.js'
export {
  BaseRetriever,
  HybridRetriever,
  TextOnlyRetriever,
  type RetrievalQuery,
  type RetrievalResult,
} from './retriever.js'
export {
  BaseReflector,
  RuleBasedReflector,
  LLMReflector,
  type ExtractedFact,
} from './reflector.js'
