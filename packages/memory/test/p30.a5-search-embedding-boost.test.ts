/**
 * P30.A5 — `BaseMemoryStore.search` embedding-boost e2e.
 *
 * The `searchSync` JSDoc in `sqlite-store.ts` enumerated three
 * strategies (FTS5, filter-only, vector path). Pre-P30.A5 the
 * third was described as "placeholder" — but the
 * implementation actually applies a cosine-similarity boost
 * in BOTH the FTS5 path (when `query.embedding` is set) and
 * the filter-only path (when both `query.embedding` and
 * `record.embedding` are set). The JSDoc lagged the code.
 *
 * P30.A5 closes the gap:
 *   - The JSDoc in `sqlite-store.ts:searchSync` is updated
 *     to reflect the actual behaviour (cosine boost, not
 *     a separate strategy).
 *   - This test file pins the behaviour so a future
 *     refactor cannot silently remove the embedding boost
 *     from the `search()` path.
 *
 * Note on the store: we test the shared `searchSync` logic
 * via the `InMemoryStore` because the `SqliteStore` upsert
 * path (P7.1) does not currently mirror the in-memory
 * `embedding` byte payload into the SQLite schema (a known
 * follow-up tracked in bug.md as a memory-correctness
 * follow-up). The `search()` and `searchSync` logic is
 * identical between the two backends; the P30.A5 regression
 * guard is on the search algorithm, not the persistence
 * layer.
 *
 * Why the boost is non-trivial: without it, a `search({ text,
 * embedding })` query would only see the BM25 score, and a
 * record with a high cosine similarity but no text overlap
 * would score below a record with low cosine but high text
 * match. The `Math.max(rec.score, cosine)` keeps the
 * stronger of the two signals per record, so vector-similar
 * records rise to the top of the result list.
 */

import { describe, expect, it } from 'vitest'
import { InMemoryStore } from '../src/index.js'

/** Insert a record with a known embedding. */
const putWithEmbedding = async (
  store: InMemoryStore,
  id: string,
  content: string,
  embedding: ReadonlyArray<number>,
  tags: ReadonlyArray<string> = [],
): Promise<void> => {
  await store.put({
    id,
    kind: 'fact',
    content,
    trust: 0.9,
    embedding: Array.from(embedding),
    tags,
  })
}

/** Insert a record without an embedding. */
const putWithoutEmbedding = async (
  store: InMemoryStore,
  id: string,
  content: string,
  trust = 0.9,
  tags: ReadonlyArray<string> = [],
): Promise<void> => {
  await store.put({
    id,
    kind: 'fact',
    content,
    trust,
    tags,
  })
}

describe('P30.A5 — BaseMemoryStore.search embedding boost', () => {
  it('FTS5 + embedding: cosine boost lifts a vector-similar record above a text-only match', async () => {
    // Two records. Both mention the word "alpha" so FTS5 ranks
    // them similarly. Their embeddings differ: "alpha bravo" is
    // close to the query embedding; "alpha charlie" is far.
    const store = new InMemoryStore()
    await putWithEmbedding(store, 'a', 'alpha bravo', [1, 0, 0, 0])
    await putWithEmbedding(store, 'b', 'alpha charlie', [0, 0, 0, 1])

    // Query with text that matches both, plus an embedding
    // that strongly aligns with [1, 0, 0, 0] (the 'a'
    // embedding). The boost should make 'a' rank first.
    const result = await store.search({
      text: 'alpha',
      embedding: [1, 0, 0, 0],
      limit: 10,
    })
    expect(result.length).toBe(2)
    // 'a' should be the first hit because its cosine similarity
    // to the query is 1.0; 'b' is 0.0.
    expect(result[0]?.record.id).toBe('a')
    expect(result[1]?.record.id).toBe('b')
    // Cosine of 'a' to query is 1.0; the boosted score should
    // be at least 0.45 (FTS BM25 of single-token match is
    // modest; the cosine boost lifts it above the 0.5 default
    // we see in the filter-only path).
    expect(result[0]?.score).toBeGreaterThan(0.45)
  })

  it('FTS5 + embedding: records with embeddings are scored (cosine * 0.5 fallback for un-embedded)', async () => {
    // One record has a known embedding; another has none. The
    // FTS path multiplies the FTS score by 0.5 for the
    // embedding-less record (so it stays in the result but
    // ranks lower), while the embedding-bearing record gets
    // the max(FTS, cosine) treatment.
    const store = new InMemoryStore()
    await putWithEmbedding(store, 'known', 'alpha bravo', [1, 0, 0, 0])
    await putWithoutEmbedding(store, 'unknown', 'alpha charlie')

    const result = await store.search({
      text: 'alpha',
      embedding: [1, 0, 0, 0],
      limit: 10,
    })
    expect(result.length).toBe(2)
    // 'known' wins because of the cosine boost; 'unknown' is
    // scored at half its FTS score because it has no
    // embedding.
    expect(result[0]?.record.id).toBe('known')
    expect(result[1]?.record.id).toBe('unknown')
  })

  it('filter-only + embedding: cosine boost raises the rank of an embedding-bearing record', async () => {
    // No text, no tags, but the records have distinct
    // embeddings. The query is "give me records close to
    // [1, 0, 0, 0]". Pre-boost, all records would score 0
    // (the InMemoryStore default for "no text, no tags" before
    // the embedding branch fires); with the boost, the close
    // one wins.
    //
    // InMemoryStore scoring: when neither text nor tags are
    // supplied, the base score is 0; the embedding branch
    // applies `Math.max(0, cosine)`. The SqliteStore variant
    // uses 0.5 as the no-text-no-tags default; both stores
    // agree on the *ordering* (close > far == none).
    const store = new InMemoryStore()
    await putWithEmbedding(store, 'close', 'no text', [1, 0, 0, 0])
    await putWithEmbedding(store, 'far', 'no text', [0, 0, 0, 1])
    await putWithoutEmbedding(store, 'none', 'no text')

    const result = await store.search({
      embedding: [1, 0, 0, 0],
      limit: 10,
    })
    expect(result.length).toBe(3)
    // 'close' has cosine 1.0 with the query → score 1.0.
    // 'far' has cosine 0.0 with the query → score 0.0.
    // 'none' has no embedding → score 0.0.
    // 'close' is the unique top hit.
    expect(result[0]?.record.id).toBe('close')
    expect(result[0]?.score).toBe(1)
    // 'far' and 'none' both have score 0; the assertion is
    // that 'close' is strictly greater than both.
    expect(result[1]?.score).toBe(0)
    expect(result[2]?.score).toBe(0)
  })

  it('embedding boost does not break minTrust filtering', async () => {
    const store = new InMemoryStore()
    await putWithEmbedding(store, 'high', 'alpha', [1, 0, 0, 0])
    await store.put({
      id: 'low',
      kind: 'fact',
      content: 'alpha',
      trust: 0.05,
      embedding: [1, 0, 0, 0],
      tags: [],
    })
    const result = await store.search({
      text: 'alpha',
      embedding: [1, 0, 0, 0],
      minTrust: 0.5,
      limit: 10,
    })
    expect(result.length).toBe(1)
    expect(result[0]?.record.id).toBe('high')
  })
})
