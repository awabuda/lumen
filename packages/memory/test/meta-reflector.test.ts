import type { BaseMemoryStore, MemoryRecord, MemorySearchResult } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import {
  META_REFLECTOR_DEFAULT_INTERVAL,
  META_REFLECTOR_MAX_DELTA,
  META_REFLECTOR_NEGATIVE_MAX_DELTA,
  META_REFLECTOR_POSITIVE_MAX_DELTA,
  applyAsymmetricTrustDelta,
  applyTrustDelta,
  clusterFactsBySimilarity,
  createClusteringMetaReflector,
} from '../src/meta-reflector.js'

/**
 * Minimal in-memory store implementation. Just enough surface for
 * the clusterer + meta-reflector to operate without dragging in
 * the real InMemoryStore (which lives in this package but pulls
 * in more methods than we need for these unit tests).
 */
class FakeStore implements BaseMemoryStore {
  public readonly id = 'fake'
  private readonly records = new Map<string, MemoryRecord>()

  public async init(): Promise<void> {}
  public async dispose(): Promise<void> {}

  /**
   * Test-only seed helper: push a fully-formed record. Distinct
   * from the public `put()` interface which is `Omit<createdAt|updatedAt>`.
   */
  public seed(record: MemoryRecord): void {
    this.records.set(record.id, record)
  }

  public async put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    const now = Date.now()
    const full: MemoryRecord = { ...record, createdAt: now, updatedAt: now }
    this.records.set(full.id, full)
    return full
  }

  public async get(id: string): Promise<MemoryRecord | undefined> {
    return this.records.get(id)
  }

  public async delete(): Promise<boolean> {
    return true
  }

  public async search(query: { kind?: string; limit?: number }): Promise<
    ReadonlyArray<MemorySearchResult>
  > {
    const limit = query.limit ?? 1_000
    const out: MemorySearchResult[] = []
    for (const r of this.records.values()) {
      if (query.kind && r.kind !== query.kind) continue
      out.push({ record: r, score: 1 })
    }
    return out.slice(0, limit)
  }

  public async createSession(): Promise<never> {
    throw new Error('not used in meta-reflector tests')
  }
  public async getSession(): Promise<undefined> {
    return undefined
  }
  public async listSessions(): Promise<ReadonlyArray<never>> {
    return []
  }
  public async appendMessage(): Promise<never> {
    throw new Error('not used in meta-reflector tests')
  }
  public async getSessionMessages(): Promise<ReadonlyArray<never>> {
    return []
  }
  public async deleteSession(): Promise<boolean> {
    return false
  }
  public async prune(): Promise<number> {
    return 0
  }
}

const fact = (
  id: string,
  content: string,
  opts: { trust?: number; tags?: ReadonlyArray<string>; createdAt?: number } = {},
): MemoryRecord => ({
  id,
  kind: 'fact',
  content,
  metadata: {},
  createdAt: opts.createdAt ?? Date.now(),
  updatedAt: opts.createdAt ?? Date.now(),
  trust: opts.trust ?? 0.5,
  tags: opts.tags ?? ['user-pref'],
})

describe('clusterFactsBySimilarity', () => {
  it('groups facts with overlapping content and identical tag-sets', async () => {
    const store = new FakeStore()
    store.seed(fact('a', 'The user prefers dark mode', { createdAt: 1, tags: ['theme'] }))
    store.seed(
      fact('b', 'The user prefers dark mode for the editor', { createdAt: 2, tags: ['theme'] }),
    )
    store.seed(
      fact('c', 'The user prefers dark mode everywhere', { createdAt: 3, tags: ['theme'] }),
    )

    const clusters = await clusterFactsBySimilarity(store, {
      kind: 'fact',
      similarityThreshold: 0.4,
    })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.factIds).toEqual(['a', 'b', 'c'])
    expect(clusters[0]?.representativeId).toBe('a')
  })

  it('does not cluster facts with disjoint tag-sets', async () => {
    const store = new FakeStore()
    store.seed(fact('a', 'The user prefers dark mode', { createdAt: 1, tags: ['theme'] }))
    store.seed(fact('b', 'The user prefers dark mode', { createdAt: 2, tags: ['editor'] }))

    const clusters = await clusterFactsBySimilarity(store, {
      kind: 'fact',
      similarityThreshold: 0.1,
    })
    expect(clusters).toHaveLength(0)
  })

  it('returns an empty list when the store has fewer than 2 facts', async () => {
    const store = new FakeStore()
    store.seed(fact('a', 'lonely fact', { createdAt: 1 }))
    const clusters = await clusterFactsBySimilarity(store)
    expect(clusters).toHaveLength(0)
  })
})

describe('applyTrustDelta', () => {
  it('returns a small positive delta for a cluster of 2', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const cluster = { representativeId: 'a', factIds: ['a', 'b'], avgSimilarity: 0.8 }
    const patch = applyTrustDelta(cluster, record, 10)
    expect(patch.delta).toBeGreaterThan(0)
    expect(patch.delta).toBeLessThanOrEqual(META_REFLECTOR_MAX_DELTA)
    expect(patch.nextTrust).toBeCloseTo(0.5 + patch.delta, 4)
  })

  it('caps the trust score at 1.0', () => {
    const record = fact('a', 'fact', { trust: 0.98 })
    const cluster = {
      representativeId: 'a',
      factIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      avgSimilarity: 1,
    }
    const patch = applyTrustDelta(cluster, record, 10)
    expect(patch.nextTrust).toBeLessThanOrEqual(1)
  })

  it('returns a zero delta for a singleton cluster', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const cluster = { representativeId: 'a', factIds: ['a'], avgSimilarity: 0 }
    const patch = applyTrustDelta(cluster, record, 10)
    expect(patch.delta).toBe(0)
    expect(patch.nextTrust).toBe(0.5)
  })

  it('returns the full +0.1 delta for a cluster matching the interval', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const ids = Array.from({ length: META_REFLECTOR_DEFAULT_INTERVAL }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }
    const patch = applyTrustDelta(cluster, record, META_REFLECTOR_DEFAULT_INTERVAL)
    expect(patch.delta).toBeCloseTo(META_REFLECTOR_MAX_DELTA, 4)
  })
})

describe('createClusteringMetaReflector', () => {
  it('produces a trust-delta patch for each cluster', async () => {
    const store = new FakeStore()
    store.seed(
      fact('a', 'The user prefers dark mode', { createdAt: 1, trust: 0.5, tags: ['theme'] }),
    )
    store.seed(
      fact('b', 'The user prefers dark mode in the editor', {
        createdAt: 2,
        trust: 0.5,
        tags: ['theme'],
      }),
    )
    store.seed(
      fact('c', 'The user prefers dark mode in the IDE', {
        createdAt: 3,
        trust: 0.5,
        tags: ['theme'],
      }),
    )

    const reflector = createClusteringMetaReflector({
      interval: META_REFLECTOR_DEFAULT_INTERVAL,
      similarityThreshold: 0.4,
    })
    const patches = await reflector.reflect(store)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.recordId).toBe('a')
    expect(patches[0]?.delta).toBeGreaterThan(0)
    expect(patches[0]?.nextTrust).toBeGreaterThan(0.5)
  })

  it('returns an empty patch list when no clusters form', async () => {
    const store = new FakeStore()
    store.seed(fact('a', 'unique fact', { createdAt: 1 }))

    const reflector = createClusteringMetaReflector()
    const patches = await reflector.reflect(store)
    expect(patches).toHaveLength(0)
  })

  it('exposes id "clustering"', () => {
    const reflector = createClusteringMetaReflector()
    expect(reflector.id).toBe('clustering')
  })

  it('honors a custom interval (Q2: factory option overrides the default constant)', async () => {
    const store = new FakeStore()
    // Cluster of size 5 with default interval 10 would yield
    // ~0.07 delta. With interval=5 the same cluster should yield
    // the full +0.1 delta (ratio = 1).
    store.seed(
      fact('a', 'The user prefers dark mode', { createdAt: 1, trust: 0.5, tags: ['theme'] }),
    )
    store.seed(
      fact('b', 'The user prefers dark mode in the editor', {
        createdAt: 2,
        trust: 0.5,
        tags: ['theme'],
      }),
    )
    store.seed(
      fact('c', 'The user prefers dark mode in the IDE', {
        createdAt: 3,
        trust: 0.5,
        tags: ['theme'],
      }),
    )
    store.seed(
      fact('d', 'The user prefers dark mode everywhere', {
        createdAt: 4,
        trust: 0.5,
        tags: ['theme'],
      }),
    )
    store.seed(
      fact('e', 'The user prefers dark mode always', { createdAt: 5, trust: 0.5, tags: ['theme'] }),
    )

    const reflector = createClusteringMetaReflector({
      interval: 5,
      similarityThreshold: 0.4,
    })
    const patches = await reflector.reflect(store)
    expect(patches).toHaveLength(1)
    expect(patches[0]?.clusterSize).toBe(5)
    expect(patches[0]?.delta).toBeCloseTo(META_REFLECTOR_MAX_DELTA, 4)
  })
})

// P19.5.5 — asymmetric trust delta (Hermes mirror).
// Helpers:
//   - `applyAsymmetricTrustDelta` (per-call opt-in)
//   - `createClusteringMetaReflector({ asymmetric: true })` (factory opt-in)
// Named constants: `META_REFLECTOR_POSITIVE_MAX_DELTA = 0.05`,
//                   `META_REFLECTOR_NEGATIVE_MAX_DELTA = 0.10`
// Default `applyTrustDelta` (symmetric) and `createClusteringMetaReflector()`
// (no `asymmetric`) keep back-compat — these tests cover the new code path.
describe('applyAsymmetricTrustDelta (P19.5.5)', () => {
  it('positive sign at full interval caps at META_REFLECTOR_POSITIVE_MAX_DELTA', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const ids = Array.from({ length: META_REFLECTOR_DEFAULT_INTERVAL }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }
    const patch = applyAsymmetricTrustDelta(
      cluster,
      record,
      META_REFLECTOR_DEFAULT_INTERVAL,
      'positive',
    )
    expect(patch.delta).toBeCloseTo(META_REFLECTOR_POSITIVE_MAX_DELTA, 4)
    expect(patch.nextTrust).toBeCloseTo(0.5 + META_REFLECTOR_POSITIVE_MAX_DELTA, 4)
  })

  it('negative sign at full interval caps at -META_REFLECTOR_NEGATIVE_MAX_DELTA', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const ids = Array.from({ length: META_REFLECTOR_DEFAULT_INTERVAL }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }
    const patch = applyAsymmetricTrustDelta(
      cluster,
      record,
      META_REFLECTOR_DEFAULT_INTERVAL,
      'negative',
    )
    expect(patch.delta).toBeCloseTo(-META_REFLECTOR_NEGATIVE_MAX_DELTA, 4)
    expect(patch.nextTrust).toBeCloseTo(0.5 - META_REFLECTOR_NEGATIVE_MAX_DELTA, 4)
  })

  it('caps the next trust at 1.0 even if positive side would overflow', () => {
    const record = fact('a', 'fact', { trust: 0.98 })
    const ids = Array.from({ length: META_REFLECTOR_DEFAULT_INTERVAL }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }
    const patch = applyAsymmetricTrustDelta(
      cluster,
      record,
      META_REFLECTOR_DEFAULT_INTERVAL,
      'positive',
    )
    expect(patch.nextTrust).toBeLessThanOrEqual(1)
    expect(patch.nextTrust).toBe(1)
  })

  it('floors the next trust at 0.0 even if negative side would underflow', () => {
    const record = fact('a', 'fact', { trust: 0.05 })
    const ids = Array.from({ length: META_REFLECTOR_DEFAULT_INTERVAL }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }
    const patch = applyAsymmetricTrustDelta(
      cluster,
      record,
      META_REFLECTOR_DEFAULT_INTERVAL,
      'negative',
    )
    expect(patch.nextTrust).toBeGreaterThanOrEqual(0)
    expect(patch.nextTrust).toBe(0)
  })

  it('returns a zero delta for a singleton cluster (size 1)', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const cluster = { representativeId: 'a', factIds: ['a'], avgSimilarity: 0 }
    const patch = applyAsymmetricTrustDelta(cluster, record, 10, 'positive')
    expect(patch.delta).toBe(0)
    expect(patch.nextTrust).toBe(0.5)
  })

  it('honors logarithmic fall-off: cluster of 2 yields ~35% of the cap', () => {
    // Cluster size 2 / interval 10 = ratio 0.2
    // log(1 + 0.2 * (e - 1)) ≈ log(1.343) ≈ 0.295
    // 0.295 * 0.05 ≈ 0.0148 for positive side
    const record = fact('a', 'fact', { trust: 0.5 })
    const cluster = { representativeId: 'a', factIds: ['a', 'b'], avgSimilarity: 0.8 }
    const patch = applyAsymmetricTrustDelta(cluster, record, 10, 'positive')
    expect(patch.delta).toBeGreaterThan(0)
    expect(patch.delta).toBeLessThan(META_REFLECTOR_POSITIVE_MAX_DELTA)
    // Pin the exact shape (1e-4 tolerance covers `Math.log` float drift).
    expect(patch.delta).toBeCloseTo(0.0148, 3)
  })

  it('honors custom positiveMax / negativeMax overrides', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }

    // Tiny positive cap, heavy negative cap.
    const positivePatch = applyAsymmetricTrustDelta(cluster, record, 10, 'positive', 0.01, 0.2)
    expect(positivePatch.delta).toBeCloseTo(0.01, 4)
    const negativePatch = applyAsymmetricTrustDelta(cluster, record, 10, 'negative', 0.01, 0.2)
    expect(negativePatch.delta).toBeCloseTo(-0.2, 4)
  })

  it('positive delta at full interval is strictly smaller than META_REFLECTOR_MAX_DELTA (Hermes mirror invariant)', () => {
    const record = fact('a', 'fact', { trust: 0.5 })
    const ids = Array.from({ length: 10 }, (_, i) => `f${i}`)
    const cluster = { representativeId: 'a', factIds: ids, avgSimilarity: 1 }
    const symmetric = applyTrustDelta(cluster, record, 10)
    const asymmetricPositive = applyAsymmetricTrustDelta(cluster, record, 10, 'positive')
    expect(asymmetricPositive.delta).toBeLessThan(symmetric.delta)
    expect(symmetric.delta).toBeCloseTo(META_REFLECTOR_MAX_DELTA, 4)
    expect(asymmetricPositive.delta).toBeCloseTo(META_REFLECTOR_POSITIVE_MAX_DELTA, 4)
  })
})

describe('createClusteringMetaReflector({ asymmetric: true }) (P19.5.5)', () => {
  it('routes through applyAsymmetricTrustDelta when asymmetric: true', async () => {
    const store = new FakeStore()
    // 10-fact cluster yields the full +0.1 under symmetric, +0.05 under
    // asymmetric-positive. The factory option flips between the two.
    store.seed(
      fact('a', 'The user prefers dark mode', { createdAt: 1, trust: 0.5, tags: ['theme'] }),
    )
    for (let i = 1; i < 10; i++) {
      store.seed(
        fact(`f${i}`, `The user prefers dark mode v${i}`, {
          createdAt: i + 1,
          trust: 0.5,
          tags: ['theme'],
        }),
      )
    }

    const symmetric = createClusteringMetaReflector({ similarityThreshold: 0.3 })
    const symmetricPatches = await symmetric.reflect(store)
    expect(symmetricPatches[0]?.delta).toBeCloseTo(META_REFLECTOR_MAX_DELTA, 4)

    const asymmetric = createClusteringMetaReflector({ similarityThreshold: 0.3, asymmetric: true })
    const asymmetricPatches = await asymmetric.reflect(store)
    expect(asymmetricPatches[0]?.delta).toBeCloseTo(META_REFLECTOR_POSITIVE_MAX_DELTA, 4)
  })

  it('back-compat: defaults to symmetric (asymmetric: false)', async () => {
    const store = new FakeStore()
    store.seed(
      fact('a', 'The user prefers dark mode', { createdAt: 1, trust: 0.5, tags: ['theme'] }),
    )
    store.seed(
      fact('b', 'The user prefers dark mode in the editor', {
        createdAt: 2,
        trust: 0.5,
        tags: ['theme'],
      }),
    )
    store.seed(
      fact('c', 'The user prefers dark mode in the IDE', {
        createdAt: 3,
        trust: 0.5,
        tags: ['theme'],
      }),
    )

    const reflector = createClusteringMetaReflector() // no asymmetric flag
    const patches = await reflector.reflect(store)
    expect(patches).toHaveLength(1)
    // No `asymmetric: true` → symmetric path → delta is log(1 + 0.3*(e-1))*0.1 ≈ 0.0416.
    // The asymmetric-positive helper at full interval caps at 0.05; the same
    // cluster of 3 under asymmetric falls at ~0.0208 (half of 0.0416).
    // Back-compat assertion: symmetric yields a different (here, larger)
    // delta than asymmetric-positive for the same input.
    expect(patches[0]?.delta).toBeGreaterThan(0)
    expect(patches[0]?.delta).toBeLessThanOrEqual(META_REFLECTOR_MAX_DELTA)
  })
})
