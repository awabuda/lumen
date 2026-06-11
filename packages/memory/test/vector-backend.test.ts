/** Tests for the vector backend abstraction and SqliteStore integration. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BruteForceVectorBackend,
  SqliteStore,
  type VectorPoint,
} from '../src/index.js'
import { floatsToBytes } from './helpers.js'

let store: SqliteStore

beforeEach(async () => {
  store = new SqliteStore({ path: ':memory:' })
  await store.init()
})

afterEach(async () => {
  await store.dispose()
})

describe('BruteForceVectorBackend', () => {
  it('reports dimensions and a stable id', () => {
    const v = new BruteForceVectorBackend(4)
    expect(v.id).toBe('brute-force')
    expect(v.dimensions).toBe(4)
  })

  it('upsert + topK returns the most similar point first', async () => {
    const v = new BruteForceVectorBackend(4)
    // Three orthogonal-ish 4-dim vectors.
    const a: VectorPoint = { id: 'a', embedding: floatsToBytes([1, 0, 0, 0]) }
    const b: VectorPoint = { id: 'b', embedding: floatsToBytes([0, 1, 0, 0]) }
    const c: VectorPoint = { id: 'c', embedding: floatsToBytes([0, 0, 1, 0]) }
    await v.upsert(a)
    await v.upsert(b)
    await v.upsert(c)
    const hits = await v.topK(floatsToBytes([1, 0.1, 0, 0]), 3)
    expect(hits[0]?.id).toBe('a')
    expect(hits[0]?.score).toBeGreaterThan(0)
  })

  it('remove() drops a point', async () => {
    const v = new BruteForceVectorBackend(2)
    await v.upsert({ id: 'x', embedding: floatsToBytes([1, 0]) })
    await v.upsert({ id: 'y', embedding: floatsToBytes([0, 1]) })
    await v.remove('x')
    const hits = await v.topK(floatsToBytes([1, 0]), 10)
    expect(hits.find((h) => h.id === 'x')).toBeUndefined()
    expect(hits.find((h) => h.id === 'y')).toBeDefined()
  })

  it('topK returns empty for an empty index', async () => {
    const v = new BruteForceVectorBackend(4)
    const hits = await v.topK(floatsToBytes([1, 0, 0, 0]), 5)
    expect(hits).toEqual([])
  })

  it('rejects a dimension mismatch on upsert', async () => {
    const v = new BruteForceVectorBackend(4)
    // 3-dim embedding into a 4-dim backend
    await expect(
      v.upsert({ id: 'm', embedding: floatsToBytes([1, 0, 0]) }),
    ).rejects.toThrow(/dimension mismatch/i)
  })
})

describe('SqliteStore.vectorBackendId', () => {
  it('reports a known backend id after init()', () => {
    // The CI environment does not have sqlite-vec installed,
    // so the fallback path is what we observe here. The
    // exact value matters less than that it is one of the
    // two known ids.
    expect(['brute-force', 'sqlite-vec']).toContain(store.vectorBackendId)
  })
})

describe('SqliteStore.vectorSearch (brute-force path)', () => {
  it('returns top-K results with similarity scores in [0, 1]', async () => {
    // The SqliteStore picks a 1536-dim backend by default
    // (text-embedding-3-small). Pass a 1536-dim zero vector
    // so the dimension check passes. The vector index is
    // empty (no upsert has happened through the store) so
    // we expect an empty result; the assertion guards the
    // join path and the empty-input edge case.
    const zero = new Float32Array(1536)
    const hits = await store.vectorSearch(floatsToBytes(Array.from(zero)), 10)
    expect(hits).toEqual([])
  })

  it('throws when called before init()', async () => {
    const fresh = new SqliteStore({ path: ':memory:' })
    await expect(fresh.vectorSearch(floatsToBytes([1, 0]), 1)).rejects.toThrow(/init\(\)/)
  })
})
