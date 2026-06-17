/** Tests for the cross-session retriever. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HybridRetriever,
  type RetrievalResult,
  SqliteStore,
  TextOnlyRetriever,
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

describe('TextOnlyRetriever', () => {
  it('returns an empty array when the query has no text', async () => {
    const r = new TextOnlyRetriever(store)
    const out = await r.retrieve({ limit: 5 })
    expect(out).toEqual([])
  })

  it('finds records by keyword match', async () => {
    await store.put({
      id: 'a',
      kind: 'fact',
      content: 'Paris is the capital of France',
      trust: 0.5,
      tags: [],
    })
    await store.put({
      id: 'b',
      kind: 'fact',
      content: 'Berlin is the capital of Germany',
      trust: 0.5,
      tags: [],
    })
    const r = new TextOnlyRetriever(store)
    const out = await r.retrieve({ text: 'paris', limit: 5 })
    const ids = out.map((h: RetrievalResult) => h.record.id)
    expect(ids).toContain('a')
    expect(ids).not.toContain('b')
  })

  it('respects the kind filter', async () => {
    await store.put({ id: 'a', kind: 'fact', content: 'apple pie', trust: 0.5, tags: [] })
    await store.put({ id: 'b', kind: 'preference', content: 'apple iphone', trust: 0.5, tags: [] })
    const r = new TextOnlyRetriever(store)
    const out = await r.retrieve({ text: 'apple', kind: 'fact', limit: 5 })
    const ids = out.map((h: RetrievalResult) => h.record.id)
    expect(ids).toEqual(['a'])
  })

  it('reports the source as text', async () => {
    await store.put({ id: 'a', kind: 'fact', content: 'apple', trust: 0.5, tags: [] })
    const r = new TextOnlyRetriever(store)
    const out = await r.retrieve({ text: 'apple' })
    expect(out[0]?.sources).toEqual(['text'])
  })
})

describe('HybridRetriever', () => {
  it('exposes the id "hybrid"', () => {
    const r = new HybridRetriever(store)
    expect(r.id).toBe('hybrid')
  })

  it('rejects a vectorWeight outside [0, 1]', () => {
    expect(() => new HybridRetriever(store, { vectorWeight: -0.1 })).toThrow(/vectorWeight/)
    expect(() => new HybridRetriever(store, { vectorWeight: 1.1 })).toThrow(/vectorWeight/)
  })

  it('falls back to text when no embedding is provided', async () => {
    await store.put({ id: 'a', kind: 'fact', content: 'apple', trust: 0.5, tags: [] })
    const r = new HybridRetriever(store)
    const out = await r.retrieve({ text: 'apple' })
    expect(out[0]?.record.id).toBe('a')
    expect(out[0]?.sources).toEqual(['text'])
  })

  it('fuses vector + text results when both are provided', async () => {
    await store.put({ id: 'a', kind: 'fact', content: 'apple pie', trust: 0.5, tags: [] })
    await store.put({ id: 'b', kind: 'fact', content: 'apple cake', trust: 0.5, tags: [] })
    // The default SqliteStore picks a 1536-dim brute-force
    // backend, so passing a 1536-dim zero vector is enough
    // to exercise the join path. The vector index is empty
    // (we never upserted) so vector results are []; the
    // text path returns both records tagged 'text'.
    const zero = new Float32Array(1536)
    const r = new HybridRetriever(store, { vectorWeight: 0.5 })
    const out = await r.retrieve({ text: 'apple', embedding: floatsToBytes(Array.from(zero)) })
    expect(out.length).toBeGreaterThan(0)
    for (const hit of out) {
      expect(hit.sources).toEqual(['text'])
    }
  })

  it('applies the kind filter to both text and vector hits', async () => {
    await store.put({ id: 'a', kind: 'fact', content: 'apple', trust: 0.5, tags: [] })
    await store.put({ id: 'b', kind: 'preference', content: 'apple', trust: 0.5, tags: [] })
    const r = new HybridRetriever(store)
    const out = await r.retrieve({ text: 'apple', kind: 'fact' })
    const ids = out.map((h: RetrievalResult) => h.record.id)
    expect(ids).toEqual(['a'])
  })
})
