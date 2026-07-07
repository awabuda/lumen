import { describe, expect, it } from 'vitest'
import type { BaseMemoryStore, MemoryRecord, MemorySearchResult } from '@lumen/core'
import {
  META_REFLECTOR_DEFAULT_INTERVAL,
  META_REFLECTOR_MAX_DELTA,
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

  public async search(query: { kind?: string; limit?: number }): Promise<ReadonlyArray<MemorySearchResult>> {
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

const fact = (id: string, content: string, opts: { trust?: number; tags?: ReadonlyArray<string>; createdAt?: number } = {}): MemoryRecord => ({
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
    store.seed(fact('b', 'The user prefers dark mode for the editor', { createdAt: 2, tags: ['theme'] }))
    store.seed(fact('c', 'The user prefers dark mode everywhere', { createdAt: 3, tags: ['theme'] }))

    const clusters = await clusterFactsBySimilarity(store, { kind: 'fact', similarityThreshold: 0.4 })
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.factIds).toEqual(['a', 'b', 'c'])
    expect(clusters[0]?.representativeId).toBe('a')
  })

  it('does not cluster facts with disjoint tag-sets', async () => {
    const store = new FakeStore()
    store.seed(fact('a', 'The user prefers dark mode', { createdAt: 1, tags: ['theme'] }))
    store.seed(fact('b', 'The user prefers dark mode', { createdAt: 2, tags: ['editor'] }))

    const clusters = await clusterFactsBySimilarity(store, { kind: 'fact', similarityThreshold: 0.1 })
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
    const cluster = { representativeId: 'a', factIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], avgSimilarity: 1 }
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
    store.seed(fact('a', 'The user prefers dark mode', { createdAt: 1, trust: 0.5, tags: ['theme'] }))
    store.seed(fact('b', 'The user prefers dark mode in the editor', { createdAt: 2, trust: 0.5, tags: ['theme'] }))
    store.seed(fact('c', 'The user prefers dark mode in the IDE', { createdAt: 3, trust: 0.5, tags: ['theme'] }))

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
})
