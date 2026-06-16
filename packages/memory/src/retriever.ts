/**
 * Cross-session retrieval.
 *
 * A {@link Retriever} pulls relevant records from a
 * {@link BaseMemoryStore} given a query. It is the
 * "remember something from a previous conversation"
 * surface, distinct from {@link BaseMemoryStore.search}
 * which is a low-level keyword/filter query.
 *
 * Two implementations ship here:
 *   - {@link HybridRetriever} — combines a vector-similarity
 *     score (when an embedding is provided) with a
 *     keyword/FTS score (when text is provided). The two
 *     signals are fused with a configurable weight.
 *   - {@link TextOnlyRetriever} — pure keyword search
 *     using {@link BaseMemoryStore.search}. Useful when
 *     no embedding model is available, or when the
 *     operator wants to keep retrieval deterministic.
 *
 * The contract is intentionally tiny. The agent loop
 * pulls a `Retriever` from the composition root and
 * calls `retrieve(query)` once per turn, then merges
 * the top-K results into the working-memory ring buffer.
 */

import type {
  BaseMemoryStore,
  BaseVectorMemoryStore,
  MemoryQuery,
  MemoryRecord,
  MemorySearchResult,
} from '@lumen/core'

/** A retrieval query. Either `text` or `embedding` (or both) should be set. */
export interface RetrievalQuery {
  /** Text to match against record content. */
  readonly text?: string
  /**
   * Float32-packed little-endian query embedding, same
   * dimensionality as the active vector backend. When
   * provided, the retriever asks the store for a vector
   *   search via {@link BaseVectorMemoryStore.vectorSearch}.
   */
  readonly embedding?: Uint8Array
  /** Restrict to records of a specific kind. */
  readonly kind?: string
  /** Maximum number of records to return. */
  readonly limit?: number
  /** Minimum trust score (0-1). */
  readonly minTrust?: number
}

export interface RetrievalResult {
  readonly record: MemoryRecord
  /** Final fused score in [0, 1]. */
  readonly score: number
  /** Which retrieval signal(s) contributed to this hit. */
  readonly sources: ReadonlyArray<'vector' | 'text' | 'filter'>
}

/** The contract every retriever implements. */
export abstract class BaseRetriever {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /** Top-K retrieval. */
  public abstract retrieve(query: RetrievalQuery): Promise<ReadonlyArray<RetrievalResult>>
}

/**
 * Hybrid retriever — vector + keyword.
 *
 * Strategy:
 *   1. If the query has a `text` part, call
 *      {@link BaseMemoryStore.search} for the keyword
 *      score. Records in the result are tagged 'text'.
 *   2. If the query has an `embedding` part, call
 *      {@link BaseVectorMemoryStore.vectorSearch} for the
 *      vector score. Records are tagged 'vector'.
 *   3. Records appearing in both lists get a fused
 *      score: `(1 - vectorWeight) * textScore +
 *      vectorWeight * vectorScore`. Records appearing in
 *      only one list keep their score from that list.
 *
 * This is a *reciprocal-rank-free* fusion. RRF would be
 * better in adversarial corpora; the linear blend is
 * easier to reason about and works well for the small
 * (< 10K) corpora we expect on a single-machine Lumen
 * install.
 *
 * The vector store is required (not optional) at the type
 * level: a {@link BaseVectorMemoryStore} contractually
 * provides `vectorSearch`. If a caller doesn't need
 * vectors they use {@link TextOnlyRetriever} instead.
 */
export class HybridRetriever extends BaseRetriever {
  public readonly id = 'hybrid'
  private readonly store: BaseVectorMemoryStore
  private readonly vectorWeight: number

  public constructor(store: BaseVectorMemoryStore, options: { vectorWeight?: number } = {}) {
    super()
    this.store = store
    const vw = options.vectorWeight ?? 0.6
    if (vw < 0 || vw > 1) {
      throw new Error(`HybridRetriever: vectorWeight must be in [0, 1], got ${vw}`)
    }
    this.vectorWeight = vw
  }

  public async retrieve(query: RetrievalQuery): Promise<ReadonlyArray<RetrievalResult>> {
    const limit = query.limit ?? 10
    const minTrust = query.minTrust ?? 0
    const textResults = query.text
      ? await this.textQuery(query, minTrust)
      : new Map<string, RetrievalResult>()
    const vectorResults = query.embedding
      ? await this.vectorQuery(query, limit)
      : new Map<string, RetrievalResult>()
    // Apply kind filter to both sides. A vector hit that
    // does not match the kind filter is dropped here.
    if (query.kind) {
      for (const [id, r] of textResults) if (r.record.kind !== query.kind) textResults.delete(id)
      for (const [id, r] of vectorResults)
        if (r.record.kind !== query.kind) vectorResults.delete(id)
    }
    // Fuse the two maps. The id is the join key.
    const fused = new Map<string, RetrievalResult>()
    for (const [id, r] of textResults) {
      fused.set(id, { ...r, sources: ['text'] })
    }
    for (const [id, r] of vectorResults) {
      const existing = fused.get(id)
      if (existing) {
        const textScore = existing.score
        const vectorScore = r.score
        fused.set(id, {
          record: r.record,
          score: (1 - this.vectorWeight) * textScore + this.vectorWeight * vectorScore,
          sources: ['text', 'vector'],
        })
      } else {
        fused.set(id, { ...r, sources: ['vector'] })
      }
    }
    return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  }

  private async textQuery(
    query: RetrievalQuery,
    minTrust: number,
  ): Promise<Map<string, RetrievalResult>> {
    const mq: MemoryQuery = {
      text: query.text,
      kind: query.kind,
      minTrust,
      limit: query.limit ?? 10,
    }
    const results = await this.store.search(mq)
    const out = new Map<string, RetrievalResult>()
    for (const r of results) {
      out.set(r.record.id, { record: r.record, score: r.score, sources: ['text'] })
    }
    return out
  }

  private async vectorQuery(
    query: RetrievalQuery,
    limit: number,
  ): Promise<Map<string, RetrievalResult>> {
    // The store is statically typed as a {@link BaseVectorMemoryStore},
    // so `vectorSearch` is part of the contract — no cast, no
    // duck-typing, no runtime `hasVector` check.
    // `query.embedding` is `Uint8Array | undefined`; this method is
    // only reached when the caller has already gated on its presence
    // (see `query()`), so the value is defined here.
    if (query.embedding === undefined) {
      return new Map<string, RetrievalResult>()
    }
    const results = await this.store.vectorSearch(query.embedding, limit)
    const out = new Map<string, RetrievalResult>()
    for (const r of results) {
      out.set(r.record.id, { record: r.record, score: r.score, sources: ['vector'] })
    }
    return out
  }
}

/**
 * Pure keyword retriever — no vector path.
 *
 * Useful for installations without an embedding model, or
 * when the operator wants deterministic, fully-traceable
 * retrieval. The store's own `search` is the only signal.
 */
export class TextOnlyRetriever extends BaseRetriever {
  public readonly id = 'text-only'
  private readonly store: BaseMemoryStore

  public constructor(store: BaseMemoryStore) {
    super()
    this.store = store
  }

  public async retrieve(query: RetrievalQuery): Promise<ReadonlyArray<RetrievalResult>> {
    if (!query.text) return []
    const results = await this.store.search({
      text: query.text,
      kind: query.kind,
      minTrust: query.minTrust,
      limit: query.limit ?? 10,
    })
    return results.map((r) => ({ record: r.record, score: r.score, sources: ['text'] }))
  }
}
