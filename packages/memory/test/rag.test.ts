/**
 * End-to-end tests for {@link RagPipeline}.
 *
 * Uses a deterministic in-test embedder (hash of char codes → unit
 * vector) so we don't need a real model. Backed by the in-process
 * {@link BruteForceVectorBackend}.
 */

import { describe, expect, it, beforeEach } from 'vitest'

import {
  BruteForceVectorBackend,
  RagPipeline,
  bytesToFloat32,
  type TextEmbedder,
  type RagChunk,
} from '../src/index.js'

const DIM = 8

/** A deterministic, dependency-free embedder: char-codes averaged and L2-normalised. */
const makeEmbedder = (): TextEmbedder => {
  return async (texts: ReadonlyArray<string>) => {
    return texts.map((t) => {
      const v = new Float32Array(DIM)
      for (let i = 0; i < t.length; i += 1) {
        v[i % DIM] = (v[i % DIM] ?? 0) + t.charCodeAt(i)
      }
      // L2 normalise so cosine sim in [-1, 1] is well-defined.
      let norm = 0
      for (const x of v) norm += x * x
      norm = Math.sqrt(norm) || 1
      for (let i = 0; i < DIM; i += 1) v[i] = (v[i] ?? 0) / norm
      return v
    })
  }
}

/** Trivial chunker: every 10 chars is one chunk. */
const charChunks = (text: string): ReadonlyArray<RagChunk> => {
  const out: RagChunk[] = []
  for (let i = 0; i < text.length; i += 10) {
    out.push({
      text: text.slice(i, i + 10),
      startOffset: i,
      endOffset: Math.min(i + 10, text.length),
      index: out.length,
    })
  }
  return out
}

describe('RagPipeline', () => {
  let backend: BruteForceVectorBackend
  let embedder: TextEmbedder

  beforeEach(() => {
    backend = new BruteForceVectorBackend(DIM)
    embedder = makeEmbedder()
  })

  it('ingest stores chunk embeddings and assigns stable ids', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    const result = await pipe.ingest({
      documentId: 'doc-1',
      text: 'hello world this is a test of the chunker',
    })

    expect(result.documentId).toBe('doc-1')
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(result.ids.length).toBe(result.chunkCount)
    // Ids are `<docId>#<hex index>`.
    for (const id of result.ids) {
      expect(id.startsWith('doc-1#')).toBe(true)
    }
  })

  it('retrieve returns top-K hits with offsets back into the source', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    const text = 'the quick brown fox jumps over the lazy dog. hello world from lumen agent.'
    await pipe.ingest({ documentId: 'doc-2', text })

    const result = await pipe.retrieve({ query: 'hello world', limit: 3 })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(result.hits.length).toBeLessThanOrEqual(3)
    for (const hit of result.hits) {
      expect(hit.id.startsWith('doc-2#')).toBe(true)
      expect(hit.text.length).toBeGreaterThan(0)
      // Offsets are inside the source text and chunk text matches.
      expect(hit.startOffset).toBeGreaterThanOrEqual(0)
      expect(hit.endOffset).toBeLessThanOrEqual(text.length)
      expect(text.slice(hit.startOffset, hit.endOffset)).toBe(hit.text)
    }
  })

  it('re-ingesting the same documentId replaces the chunks (idempotent)', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    await pipe.ingest({ documentId: 'doc-3', text: 'first version of the document text' })
    // Re-ingest with completely new content. The first ingest's
    // chunks should be forgotten before the new ones are stored.
    await pipe.ingest({
      documentId: 'doc-3',
      text: 'completely different content for second version',
    })

    // Total stored chunks should equal the second ingest's count,
    // not double.
    const { hits: allHits } = await pipe.retrieve({ query: 'version', limit: 100 })
    for (const hit of allHits) {
      // The first ingest's text was "first version of the document text" —
      // those chunks are gone, only second-ingest chunks remain.
      expect(hit.text.startsWith('first version')).toBe(false)
      // Each hit belongs to doc-3, no stale ids.
      expect(hit.id.startsWith('doc-3#')).toBe(true)
    }
  })

  it('forget removes every chunk belonging to the document', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    await pipe.ingest({ documentId: 'doc-4', text: 'to be forgotten soon' })
    expect((await pipe.retrieve({ query: 'forgotten', limit: 10 })).hits.length).toBeGreaterThan(0)

    await pipe.forget('doc-4')
    expect((await pipe.retrieve({ query: 'forgotten', limit: 10 })).hits.length).toBe(0)
  })

  it('retrieve returns empty hits when nothing has been ingested', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    const result = await pipe.retrieve({ query: 'anything', limit: 5 })
    expect(result.hits).toEqual([])
  })

  it('respects the limit option on retrieve', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    // 100 chars → 10 chunks.
    const text = 'a'.repeat(100)
    await pipe.ingest({ documentId: 'doc-5', text })
    const r1 = await pipe.retrieve({ query: 'a', limit: 1 })
    const r5 = await pipe.retrieve({ query: 'a', limit: 5 })
    expect(r1.hits.length).toBe(1)
    expect(r5.hits.length).toBe(5)
  })

  it('caller-supplied chunks bypass the chunker', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    const custom: RagChunk[] = [
      { text: 'alpha', startOffset: 0, endOffset: 5, index: 0 },
      { text: 'beta', startOffset: 6, endOffset: 10, index: 1 },
    ]
    const result = await pipe.ingest({ documentId: 'doc-6', text: 'ignored', chunks: custom })
    expect(result.chunkCount).toBe(2)
    const r = await pipe.retrieve({ query: 'alpha', limit: 2 })
    expect(r.hits.map((h) => h.text)).toContain('alpha')
  })

  it('emits per-chunk events via onChunk', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    const events: string[] = []
    await pipe.ingest({
      documentId: 'doc-7',
      text: 'eventful text',
      onChunk: ({ id }) => events.push(id),
    })
    expect(events.length).toBeGreaterThan(0)
    for (const id of events) expect(id.startsWith('doc-7#')).toBe(true)
  })

  it('rejects chunks with invalid shape (validation)', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    // P10 switched hand-rolled validation to Zod. The error
    // shape is now the schema's `startOffset: number().min(0)`
    // reported as "Number must be greater than or equal to 0"
    // on the field path `chunks.0.startOffset`.
    await expect(
      pipe.ingest({
        documentId: 'doc-8',
        text: 'ignored',
        chunks: [{ text: 'x', startOffset: -1, endOffset: 2, index: 0 }],
      }),
    ).rejects.toThrow(/startOffset/)
  })

  it('embedding bytes round-trip through bytesToFloat32', async () => {
    const pipe = new RagPipeline({ embedder, backend, chunker: charChunks })
    await pipe.ingest({ documentId: 'doc-9', text: 'round trip test' })
    const r = await pipe.retrieve({ query: 'round', limit: 1 })
    expect(r.hits.length).toBe(1)
    // Score should be in [-1, 1] (cosine).
    const score = r.hits[0]!.score
    expect(score).toBeGreaterThanOrEqual(-1)
    expect(score).toBeLessThanOrEqual(1)

    // Verify bytesToFloat32 is exposed and works.
    const v = bytesToFloat32(new Uint8Array(new Float32Array([0.5, -0.5]).buffer), 2)
    expect(v.length).toBe(2)
    expect(v[0]).toBeCloseTo(0.5)
    expect(v[1]).toBeCloseTo(-0.5)
  })
})
