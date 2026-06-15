/**
 * Tests for the embedding bridge.
 *
 * We do not depend on `@lumen/llm` here — the bridge's whole point is
 * to be provider-agnostic, and the test suite is the right place to
 * prove that. We feed a stub `EmbeddingSource` and assert the
 * `TextEmbedder` output is shaped for the vector backends.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  bytesToFloat32,
  createProviderEmbedder,
  float32ToBytes,
  type EmbeddingSource,
} from '../src/embedder.js'

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

/** A stub `EmbeddingSource` whose every embed() call records the
 *  request and returns a programmable response. */
const makeStubSource = (response: () => Promise<{ vectors: ReadonlyArray<ReadonlyArray<number>>; model: string }>) => {
  const calls: Array<{ input: ReadonlyArray<string>; model: string }> = []
  const source: EmbeddingSource = {
    async embed(request) {
      calls.push({ input: [...request.input], model: request.model })
      return response()
    },
  }
  return { source, calls }
}

const FIXED_4D = (values: ReadonlyArray<ReadonlyArray<number>>) => () =>
  Promise.resolve({ vectors: values, model: 'stub-embed-v1' })

// ---------------------------------------------------------------------------
// createProviderEmbedder
// ---------------------------------------------------------------------------

describe('createProviderEmbedder', () => {
  it('returns one Float32Array per input string with the right length', async () => {
    const { source, calls } = makeStubSource(
      FIXED_4D([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]),
    )
    const embed = createProviderEmbedder(source, { model: 'stub-embed-v1' })
    const out = await embed(['hello', 'world'])
    expect(out).toHaveLength(2)
    expect(out[0]).toBeInstanceOf(Float32Array)
    expect(out[0]!.length).toBe(4)
    expect(Array.from(out[0]!)).toEqual([1, 2, 3, 4])
    expect(Array.from(out[1]!)).toEqual([5, 6, 7, 8])
    expect(calls).toEqual([{ input: ['hello', 'world'], model: 'stub-embed-v1' }])
  })

  it('returns [] for an empty input without calling the source', async () => {
    const embed = vi.fn()
    const source: EmbeddingSource = { embed }
    const e = createProviderEmbedder(source, { model: 'm' })
    await expect(e([])).resolves.toEqual([])
    expect(embed).not.toHaveBeenCalled()
  })

  it('passes the configured model on every call', async () => {
    const { source, calls } = makeStubSource(FIXED_4D([[1, 2, 3, 4]]))
    const embed = createProviderEmbedder(source, { model: 'mistral-embed' })
    await embed(['a'])
    await embed(['b'])
    expect(calls.map((c) => c.model)).toEqual(['mistral-embed', 'mistral-embed'])
  })

  it('throws when the source returns zero vectors for a non-empty input', async () => {
    const { source } = makeStubSource(() => Promise.resolve({ vectors: [], model: 'm' }))
    const embed = createProviderEmbedder(source, { model: 'm' })
    await expect(embed(['a'])).rejects.toThrow(/empty embedding response/)
  })

  it('throws when a vector has a different length from the first one', async () => {
    const { source } = makeStubSource(
      FIXED_4D([
        [1, 2, 3, 4],
        [5, 6, 7], // 3-dim, mismatches
      ]),
    )
    const embed = createProviderEmbedder(source, { model: 'm' })
    await expect(embed(['a', 'b'])).rejects.toThrow(/dimension mismatch at index 1\/2/)
  })

  it('throws when the configured dimensions do not match the response', async () => {
    const { source } = makeStubSource(FIXED_4D([[1, 2, 3, 4]]))
    const embed = createProviderEmbedder(source, { model: 'm', dimensions: 1024 })
    await expect(embed(['a'])).rejects.toThrow(/expected 1024, got 4/)
  })

  it('rejects when constructed without a model', () => {
    const source: EmbeddingSource = {
      async embed() {
        return { vectors: [], model: '' }
      },
    }
    expect(() => createProviderEmbedder(source, { model: '' })).toThrow(/options\.model is required/)
  })

  it('propagates provider errors (e.g. Anthropic has no embedding)', async () => {
    const source: EmbeddingSource = {
      async embed() {
        throw new Error('Provider anthropic does not support embeddings')
      },
    }
    const embed = createProviderEmbedder(source, { model: 'm' })
    await expect(embed(['a'])).rejects.toThrow(/does not support embeddings/)
  })
})

// ---------------------------------------------------------------------------
// float32ToBytes / bytesToFloat32
// ---------------------------------------------------------------------------

describe('float32ToBytes / bytesToFloat32', () => {
  it('round-trips a Float32Array', () => {
    const original = new Float32Array([0.5, -1.25, 3.14, 0])
    const bytes = float32ToBytes(original)
    expect(bytes).toBeInstanceOf(Uint8Array)
    const back = bytesToFloat32(bytes, 4)
    expect(Array.from(back)).toEqual(Array.from(original))
  })

  it('writes little-endian float32 bytes (consumable by vector backends)', () => {
    // 1.0 as little-endian float32 = 0x00 0x00 0x80 0x3F
    const bytes = float32ToBytes(new Float32Array([1.0]))
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0x80, 0x3f])
  })

  it('copies the buffer so the caller can mutate the input safely', () => {
    const original = new Float32Array([1, 2, 3, 4])
    const bytes = float32ToBytes(original)
    original[0] = 999
    const back = bytesToFloat32(bytes, 4)
    expect(back[0]).toBe(1)
  })

  it('bytesToFloat32 throws on length mismatch', () => {
    const bytes = float32ToBytes(new Float32Array([1, 2, 3, 4]))
    expect(() => bytesToFloat32(bytes, 5)).toThrow(/expected length 5, got 4/)
  })
})
