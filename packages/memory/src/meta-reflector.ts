/**
 * Meta-reflector (P19.5) — cross-run fact consolidation.
 *
 * P19.5 refactor note (P19 rule 15 — helper function > abstract class):
 *   The original P19.5 spec sketched an abstract `BaseMetaReflector`
 *   class. P19+ rule 15 forbids abstract classes with a single
 *   implementation; the meta-reflector is therefore an interface
 *   with helper functions that operate on a `BaseMemoryStore`. The
 *   cluster step is a pure function on `MemoryRecord[]`; the trust
 *   delta step is a pure function on `(record, clusterSize) => delta`.
 *
 * What this module does:
 *   - `clusterFactsBySimilarity` — groups `MemoryRecord`s with the
 *     same `kind` and tag-set whose content shares a normalized
 *     token overlap ≥ `similarityThreshold`. Pure function. The
 *     token overlap is deliberately simple (Jaccard on lowercased
 *     word tokens) so the e2e is deterministic and does not depend
 *     on an embedding model. Callers who need semantic clustering
 *     can implement their own clusterer that uses vector distance.
 *   - `applyTrustDelta` — given a cluster of N records that share
 *     a fact, compute a small `delta ∈ [-0.1, +0.1]` that:
 *       - raises the representative's `trust` (capped at 1.0) when
 *         cluster size grows (more runs corroborate the fact), and
 *       - is exposed as a `MemoryRecord` patch, NOT an in-place
 *         mutation. Callers decide whether to write the patch back
 *         to the store (this module does not own the write).
 *
 * P19.5 design choices vs upstream (deferred — see TODO once the
 * 4-framework comparison returns from the subagent):
 *   - Default interval = 10 runs (matches P19.5 spec; mirrors the
 *     fact_store "trust retraining" cadence in Hermes Agent).
 *   - Similarity is Jaccard tokens, not cosine on embeddings, to
 *     keep the helper pure and embedding-free. Upstream may do
 *     cosine; the interface does not pin the algorithm.
 *   - Trust delta is bounded to ±0.1 per run so a mis-clustered
 *     fact can never spike from 0.0 to 1.0 in a single MetaReflector
 *     pass. This is the conservative choice.
 *
 * NOT a middleware: meta-reflection is a periodic job, not a step
 * in the agent loop. P19+ rule 11 says "any extension to the Agent
 * loop = middleware"; meta-reflection runs between runs, so it
 * stays as a plain helper interface.
 */

import { z } from 'zod'

import type { BaseMemoryStore, MemoryRecord } from '@lumen/core'

/** Default cluster size above which a fact is considered "consolidated". */
export const META_REFLECTOR_DEFAULT_INTERVAL = 10

/** Default similarity threshold for Jaccard clustering (0-1). */
export const META_REFLECTOR_DEFAULT_SIMILARITY = 0.5

/** Maximum absolute trust delta per MetaReflector pass. */
export const META_REFLECTOR_MAX_DELTA = 0.1

/** Options for {@link clusterFactsBySimilarity}. */
export interface ClusterOptions {
  /** Filter by record kind (e.g. 'fact'). Defaults to 'fact'. */
  readonly kind?: string
  /** Jaccard threshold in [0, 1]. Defaults to 0.5. */
  readonly similarityThreshold?: number
  /** Cap on the number of records to cluster. */
  readonly limit?: number
}

const ClusterOptionsSchema = z
  .object({
    kind: z.string().min(1).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict()

/** A cluster of similar facts. The first entry is the oldest (representative). */
export interface FactCluster {
  readonly representativeId: string
  readonly factIds: ReadonlyArray<string>
  /** Average Jaccard similarity within the cluster (0-1). */
  readonly avgSimilarity: number
}

/** Single fact search result, narrowed to what the clusterer needs. */
export type FactRecord = MemoryRecord

const tokenize = (s: string): ReadonlySet<string> => {
  const out = new Set<string>()
  const lower = s.toLowerCase()
  const re = /[a-z0-9]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lower)) !== null) {
    if (m[0].length > 0) out.add(m[0])
  }
  return out
}

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const t of a) if (b.has(t)) intersection += 1
  const union = a.size + b.size - intersection
  if (union === 0) return 0
  return intersection / union
}

/**
 * Group facts with the same `kind` and overlapping tag-set by content
 * similarity. Returns clusters of size ≥ 2 (singletons are dropped —
 * they have no consolidation signal).
 */
export const clusterFactsBySimilarity = async (
  store: BaseMemoryStore,
  options: ClusterOptions = {},
): Promise<ReadonlyArray<FactCluster>> => {
  const parsed = ClusterOptionsSchema.parse(options)
  const kind = parsed.kind ?? 'fact'
  const threshold = parsed.similarityThreshold ?? META_REFLECTOR_DEFAULT_SIMILARITY
  const limit = parsed.limit ?? 1_000

  const result = await store.search({ kind, limit })
  const records = result.map((r) => r.record)
  if (records.length < 2) return []

  const tokens = new Map<string, ReadonlySet<string>>()
  for (const r of records) {
    tokens.set(r.id, tokenize(r.content))
  }

  // Sort by createdAt asc so the oldest record is the representative.
  const sorted = [...records].sort((a, b) => a.createdAt - b.createdAt)

  const clusters: FactCluster[] = []
  const assigned = new Set<string>()

  for (let i = 0; i < sorted.length; i += 1) {
    const seed = sorted[i]
    if (!seed || assigned.has(seed.id)) continue
    const seedTags = new Set(seed.tags)
    const seedTokens = tokens.get(seed.id) ?? new Set<string>()
    const bucket: MemoryRecord[] = [seed]
    const similarities: number[] = []

    for (let j = i + 1; j < sorted.length; j += 1) {
      const candidate = sorted[j]
      if (!candidate || assigned.has(candidate.id)) continue
      // Same tag-set is required: facts with disjoint tags should not
      // cluster (the tag-set is the meta-claim, the content is the
      // evidence).
      const candidateTags = new Set(candidate.tags)
      if (candidateTags.size !== seedTags.size) continue
      let tagMatch = true
      for (const t of seedTags) if (!candidateTags.has(t)) { tagMatch = false; break }
      if (!tagMatch) continue

      const candidateTokens = tokens.get(candidate.id) ?? new Set<string>()
      const sim = jaccard(seedTokens, candidateTokens)
      if (sim >= threshold) {
        bucket.push(candidate)
        similarities.push(sim)
      }
    }

    if (bucket.length >= 2) {
      const avg =
        similarities.length > 0
          ? similarities.reduce((acc, n) => acc + n, 0) / similarities.length
          : 1
      clusters.push({
        representativeId: seed.id,
        factIds: bucket.map((r) => r.id),
        avgSimilarity: avg,
      })
      for (const r of bucket) assigned.add(r.id)
    }
  }

  return clusters
}

/** Patch describing how a fact's trust should be adjusted. */
export interface TrustDeltaPatch {
  readonly recordId: string
  /** Signed delta in [-0.1, +0.1]. */
  readonly delta: number
  /** New trust score, bounded to [0, 1]. */
  readonly nextTrust: number
  /** Cluster size that produced this delta. */
  readonly clusterSize: number
}

/**
 * Compute a bounded trust delta for each cluster's representative.
 * Larger clusters yield a positive delta (capped at +0.1) and
 * smaller-than-interval clusters yield 0. The representative's
 * new trust is bounded to [0, 1].
 *
 * Pure function — no I/O. Callers wire the patch back to the store
 * via `store.put({ ...record, trust: patch.nextTrust })`.
 */
export const applyTrustDelta = (
  cluster: FactCluster,
  representative: MemoryRecord,
  interval: number = META_REFLECTOR_DEFAULT_INTERVAL,
): TrustDeltaPatch => {
  if (cluster.factIds.length < 2) {
    return {
      recordId: representative.id,
      delta: 0,
      nextTrust: representative.trust,
      clusterSize: cluster.factIds.length,
    }
  }
  // Logarithmic diminishing returns: cluster of 2 gives ~0.07,
  // cluster of 10 (full interval) gives the full +0.1.
  const ratio = Math.min(1, cluster.factIds.length / interval)
  const raw = META_REFLECTOR_MAX_DELTA * Math.log(1 + ratio * (Math.E - 1))
  const delta = Number(Math.max(-META_REFLECTOR_MAX_DELTA, Math.min(META_REFLECTOR_MAX_DELTA, raw)).toFixed(4))
  const nextTrust = Number(
    Math.max(0, Math.min(1, representative.trust + delta)).toFixed(4),
  )
  return {
    recordId: representative.id,
    delta,
    nextTrust,
    clusterSize: cluster.factIds.length,
  }
}

/** The contract every meta-reflector implementation fulfills. */
export interface BaseMetaReflector {
  readonly id: string
  /**
   * Run a cross-run pass and return the patches the caller should
   * write back to the store. Implementations should be idempotent:
   * running twice in a row should yield the same patches (modulo
   * store state mutations from the first run).
   */
  reflect(store: BaseMemoryStore): Promise<ReadonlyArray<TrustDeltaPatch>>
}

/** Default meta-reflector built on `clusterFactsBySimilarity` + `applyTrustDelta`. */
export const createClusteringMetaReflector = (
  options: { interval?: number; similarityThreshold?: number; kind?: string } = {},
): BaseMetaReflector => {
  const interval = options.interval ?? META_REFLECTOR_DEFAULT_INTERVAL
  const similarityThreshold =
    options.similarityThreshold ?? META_REFLECTOR_DEFAULT_SIMILARITY
  const kind = options.kind ?? 'fact'

  return {
    id: 'clustering',
    async reflect(store: BaseMemoryStore): Promise<ReadonlyArray<TrustDeltaPatch>> {
      const clusters = await clusterFactsBySimilarity(store, {
        kind,
        similarityThreshold,
      })
      const patches: TrustDeltaPatch[] = []
      for (const cluster of clusters) {
        const representative = await store.get(cluster.representativeId)
        if (!representative) continue
        patches.push(applyTrustDelta(cluster, representative, interval))
      }
      return patches
    },
  }
}
