/**
 * Bridge between {@link BaseProvider.embed | LLM embedding providers} and
 * the {@link BaseVectorBackend} contract used by the retriever.
 *
 * The memory package is intentionally provider-agnostic: a
 * {@link HybridRetriever} accepts a `Float32Array` query and stores
 * vectors as `Uint8Array` blobs. Almost every real agent, however,
 * wants to point the retriever at a hosted embedding endpoint
 * (Mistral, OpenAI, Gemini, …) and feed it natural-language text.
 *
 * This module is the glue. The shape of the `EmbeddingSource` we
 * accept is intentionally *structural* — it mirrors the
 * {@link EmbedRequest} / {@link EmbedResponse} interface from
 * `@lumen/core` but is defined inline so this file has no compile-time
 * dependency on `@lumen/llm`. The `@lumen/llm` package depends on
 * `@lumen/core`; we do not want to introduce a back-edge.
 *
 * Typical wiring:
 *
 * ```ts
 * import { createProviderEmbedder } from '@lumen/memory'
 * import { createMistralProvider } from '@lumen/llm'
 *
 * const provider = createMistralProvider({ apiKey })
 * const embed = createProviderEmbedder(provider, { model: 'mistral-embed' })
 * const vectors = await embed(['hello', 'world'])
 * // → [Float32Array, Float32Array] (each length 1024 for mistral-embed)
 * ```
 */

import type { EmbedRequest, EmbedResponse } from '@lumen/core'
import { ConfigError, ProviderError, ValidationError } from '@lumen/core'

// ---------------------------------------------------------------------------
// Structural type for an embedding source
// ---------------------------------------------------------------------------

/**
 * The minimum surface we need from a provider to power
 * {@link createProviderEmbedder}. Matches `BaseProvider.embed` from
 * `@lumen/core`; declared structurally so we do not have to import
 * `@lumen/llm` (and so callers can plug in non-`BaseProvider`
 * implementations in tests).
 */
export interface EmbeddingSource {
  embed(request: EmbedRequest): Promise<EmbedResponse>
}

/** Options for {@link createProviderEmbedder}. */
export interface ProviderEmbedderOptions {
  /**
   * Default model name to send on every {@link EmbedRequest}. Required
   * for any provider whose `embed()` does not default a model (which is
   * every provider in `@lumen/llm` today). May be overridden per call.
   */
  readonly model: string
  /**
   * Optional explicit dimensionality. When set, we assert every
   * returned vector matches the declared length and convert to
   * `Float32Array` directly. When unset, we infer from the first
   * vector and re-use the inferred length for the rest.
   */
  readonly dimensions?: number
  /**
   * Optional AbortSignal that will be attached to every embed call.
   * Useful for cancelling a long batch when the parent agent run is
   * aborted.
   */
  readonly signal?: AbortSignal
}

/** A function that turns text strings into float32 vectors. */
export type TextEmbedder = (texts: ReadonlyArray<string>) => Promise<ReadonlyArray<Float32Array>>

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

/**
 * Wrap a provider-shaped `embed` source as a pure `TextEmbedder`.
 *
 * The returned function batches every call into a single
 * `EmbedRequest` (the wire protocol for every provider in
 * `@lumen/llm` accepts a string array), validates the response
 * dimensionality, and returns one `Float32Array` per input text.
 *
 * Errors:
 *   - `Provider does not support embeddings` — bubbled up from
 *     providers whose `capabilities.embeddings` is false (Anthropic).
 *     Callers that want a graceful fallback should check
 *     `provider.capabilities.embeddings` first.
 *   - `Embedding dimension mismatch` — thrown when the declared
 *     `options.dimensions` does not match the response.
 *   - `Empty embedding response` — thrown when the provider returns
 *     zero vectors for a non-empty input.
 */
export function createProviderEmbedder(
  source: EmbeddingSource,
  options: ProviderEmbedderOptions,
): TextEmbedder {
  if (!options.model) {
    throw new ValidationError('createProviderEmbedder: options.model is required', {
      field: 'model',
    })
  }
  return async (texts: ReadonlyArray<string>): Promise<ReadonlyArray<Float32Array>> => {
    if (texts.length === 0) return []
    const response = await source.embed({
      input: texts,
      model: options.model,
    })
    if (response.vectors.length === 0) {
      throw new ProviderError(
        'createProviderEmbedder: provider returned empty embedding response',
        {
          providerId: 'embedder',
          retryable: true,
        },
      )
    }
    const expectedDimensions = options.dimensions ?? response.vectors[0]!.length
    return response.vectors.map((vec, i) => toFloat32(vec, expectedDimensions, i, texts.length))
  }
}

// ---------------------------------------------------------------------------
// <-> Vector backend byte conversion
// ---------------------------------------------------------------------------

/**
 * Encode a single float32 vector as a `Uint8Array` (little-endian, the
 * wire format `BaseVectorBackend` consumes). Used by callers that want
 * to write embeddings they got from {@link createProviderEmbedder} into
 * a {@link BruteForceVectorBackend} or sqlite-vec table directly,
 * without going through {@link HybridRetriever}.
 */
export function float32ToBytes(embedding: Float32Array): Uint8Array {
  // We copy into a fresh ArrayBuffer so the caller can mutate the
  // input Float32Array without poisoning our stored bytes.
  const ab = new ArrayBuffer(embedding.byteLength)
  new Float32Array(ab).set(embedding)
  return new Uint8Array(ab)
}

/** Inverse of {@link float32ToBytes}. */
export function bytesToFloat32(bytes: Uint8Array, expectedLength: number): Float32Array {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const f = new Float32Array(ab)
  if (f.length !== expectedLength) {
    throw new ConfigError(`bytesToFloat32: expected length ${expectedLength}, got ${f.length}`)
  }
  return f
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const toFloat32 = (
  vec: ReadonlyArray<number>,
  expected: number,
  index: number,
  total: number,
): Float32Array => {
  if (vec.length !== expected) {
    throw new ConfigError(
      `createProviderEmbedder: embedding dimension mismatch at index ${index}/${total}: ` +
        `expected ${expected}, got ${vec.length}`,
    )
  }
  const out = new Float32Array(expected)
  for (let i = 0; i < expected; i += 1) out[i] = vec[i] ?? 0
  return out
}
