/**
 * Mistral AI provider.
 *
 * Mistral's public API is OpenAI-compatible: chat, streaming, and embeddings
 * all follow the OpenAI wire format with one twist — the embeddings
 * endpoint lives at `/v1/embeddings` and uses Mistral's own `mistral-embed`
 * model (1024-dimensional vectors). This module is therefore a thin
 * {@link OpenAICompatibleProvider} subclass that:
 *
 *   1. Pins Mistral's defaults (base URL, default model, provider id).
 *   2. Overrides `embed()` to call `/v1/embeddings` (the base class throws
 *      for embeddings because the chat-completions surface doesn't cover
 *      them).
 *
 * Protocol references:
 *   - https://docs.mistral.ai/api/  (general API entry)
 *   - https://docs.mistral.ai/category/chat-completions  (chat spec)
 *   - https://docs.mistral.ai/category/embeddings  (embeddings spec)
 *
 * Implementation notes:
 *   - Auth is `Authorization: Bearer *** identical to OpenAI.
 *   - Chat completions: `POST {baseUrl}/chat/completions`.
 *   - Embeddings: `POST {baseUrl}/embeddings` with model `mistral-embed`.
 *   - Tool calls: identical to OpenAI's `tools` + `tool_calls` shape.
 *   - Streaming: server-sent events, identical to OpenAI.
 *
 * The factory in this file only sets defaults; callers can still pass a
 * custom `baseUrl` (e.g. for Mistral Codestral's `codestral.mistral.ai`
 * endpoint or a self-hosted vLLM serving Mistral weights) by constructing
 * {@link MistralProvider} directly.
 */

import { z } from 'zod'
import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openai-compatible.js'
import { parseResponseJson } from './errors.js'
import {
  ProviderError,
  type EmbedRequest,
  type EmbedResponse,
  type StreamOptions,
  ValidationError,
} from '@lumen/core'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default base URL for the public Mistral API.
 *
 * Mistral Codestral lives at a different host (`codestral.mistral.ai`); if
 * you need Codestral, construct a {@link MistralProvider} directly with
 * that base URL — this factory is for the general-purpose Chat
 * Completions endpoint.
 */
export const DEFAULT_MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'

/**
 * Default chat model.
 *
 * `mistral-large-latest` is Mistral's top-tier general model at the time
 * of writing. Switch to `mistral-small-latest` for cost-sensitive workloads
 * or to a specific dated snapshot (e.g. `mistral-large-2407`) for
 * reproducibility.
 */
export const DEFAULT_MISTRAL_MODEL = 'mistral-large-latest'

/**
 * Default embedding model.
 *
 * Mistral exposes a single embedding model family: `mistral-embed`. It
 * produces 1024-dimensional vectors and supports multiple languages.
 */
export const DEFAULT_MISTRAL_EMBED_MODEL = 'mistral-embed'

/** Provider identifier used in `BaseProvider.id` and `X-Provider` headers. */
export const MISTRAL_PROVIDER_ID = 'mistral'

// ---------------------------------------------------------------------------
// Zod schemas for Mistral's OpenAI-compatible responses
// ---------------------------------------------------------------------------

const MistralEmbedDataItemSchema = z.object({
  index: z.number().int().nonnegative(),
  embedding: z.array(z.number()),
})

const MistralEmbedResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  data: z.array(MistralEmbedDataItemSchema),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
})

// ---------------------------------------------------------------------------
// Provider class
// ---------------------------------------------------------------------------

/**
 * Concrete Mistral provider.
 *
 * Wraps {@link OpenAICompatibleProvider} for chat/streaming and adds
 * embeddings support on top. Direct construction is exposed for callers
 * that need to point at a non-default base URL (Codestral, self-hosted
 * gateway, etc.) — most callers should use {@link createMistralProvider}.
 */
export class MistralProvider extends OpenAICompatibleProvider {
  private readonly embedModel: string
  private readonly embedFetchImpl: typeof fetch
  /** Mirror of the normalized base URL the base class stored privately. */
  private readonly embedBaseUrl: string

  constructor(
    options: OpenAICompatibleOptions & {
      /** Override the embedding model. Defaults to {@link DEFAULT_MISTRAL_EMBED_MODEL}. */
      readonly embedModel?: string
    },
  ) {
    // Mistral supports embeddings; the base class defaults to false.
    super({ ...options, capabilities: { ...(options.capabilities ?? {}), embeddings: true } })
    this.embedModel = options.embedModel ?? DEFAULT_MISTRAL_EMBED_MODEL
    // The base class keeps its own private fetchImpl; we need access too,
    // so we mirror the resolution logic here.
    this.embedFetchImpl =
      options.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as typeof fetch)
        : (() => {
            throw new ValidationError(
              'MistralProvider: no fetch implementation available. Pass `fetchImpl` or run on Node 20+.',
              { field: 'fetchImpl' },
            )
          })())
    // Mirror the base class's URL normalization (strip trailing slashes).
    this.embedBaseUrl = (options.baseUrl ?? DEFAULT_MISTRAL_BASE_URL).replace(/\/+$/, '')
  }

  /**
   * Embed a list of inputs using Mistral's `/v1/embeddings` endpoint.
   *
   * Mistral accepts one input per request (batching is client-side), so
   * this method fires one HTTP request per input. Returns
   * {@link EmbedResponse} with vectors in the input order.
   *
   * @throws {@link ProviderError} for non-2xx responses.
   * @throws DOMException `AbortError` when `options.signal` fires.
   */
  public override async embed(
    request: EmbedRequest,
    options?: StreamOptions,
  ): Promise<EmbedResponse> {
    const model = request.model || this.embedModel
    const vectors: number[][] = []
    for (const input of request.input) {
      const url = `${this.baseUrlForEmbeddings()}/embeddings`
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      }
      const body = JSON.stringify({ model, input })
      const response = await this.embedFetchImpl(url, {
        method: 'POST',
        headers,
        body,
        ...(options?.signal ? { signal: options.signal } : {}),
      })
      const text = await response.text()
      if (!response.ok) {
        throw new ProviderError(`Mistral embeddings returned HTTP ${response.status}`, {
          providerId: this.id,
          statusCode: response.status,
          retryable: response.status >= 500 || response.status === 429,
        })
      }
      const parsed = parseResponseJson(text, MistralEmbedResponseSchema)
      // Preserve order; Mistral returns `data: [{ index, embedding }, ...]`
      // but the server is allowed to shuffle, so we re-sort by index.
      const sorted = [...parsed.data].sort((a, b) => a.index - b.index)
      const first = sorted[0]
      if (!first) {
        throw new ProviderError('Mistral embeddings returned 0 vectors', {
          providerId: this.id,
          retryable: false,
        })
      }
      vectors.push(first.embedding)
    }
    return {
      vectors,
      model,
      ...(request.input.length > 0
        ? { usage: { inputTokens: request.input.reduce((n, s) => n + s.length, 0) } }
        : {}),
    }
  }

  /**
   * Internal hook so the embed method can build URLs without re-deriving
   * `baseUrl` (which is private on the base class). Uses the same
   * normalized URL the base class stored.
   */
  private baseUrlForEmbeddings(): string {
    return this.embedBaseUrl
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link createMistralProvider}.
 *
 * All fields except `apiKey` and `defaultModel` are optional. The
 * `defaultModel` field has a sensible Mistral default but most callers
 * will override it; pass it explicitly to avoid surprises.
 */
export interface MistralProviderOptions {
  /** Mistral API key. Required. */
  readonly apiKey: string
  /**
   * Default chat model. Defaults to {@link DEFAULT_MISTRAL_MODEL}
   * (`mistral-large-latest`).
   */
  readonly defaultModel?: string
  /**
   * Override the base URL. Defaults to
   * {@link DEFAULT_MISTRAL_BASE_URL}. Useful for self-hosted gateways,
   * proxies, or Codestral's separate endpoint.
   */
  readonly baseUrl?: string
  /**
   * Override the provider identifier exposed by `BaseProvider.id`.
   * Defaults to {@link MISTRAL_PROVIDER_ID} (`mistral`).
   */
  readonly id?: string
  /**
   * Override the embedding model. Defaults to
   * {@link DEFAULT_MISTRAL_EMBED_MODEL} (`mistral-embed`).
   */
  readonly embedModel?: string
  /**
   * Extra HTTP headers attached to every request (e.g. custom tracing
   * headers or organization-scoped API keys).
   */
  readonly defaultHeaders?: Readonly<Record<string, string>>
  /** Request timeout in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Custom `fetch` implementation. Injected so tests can intercept
   * requests without hitting the network.
   */
  readonly fetchImpl?: typeof fetch
}

/**
 * Build a {@link MistralProvider} pointed at the Mistral API.
 *
 * The returned provider's `capabilities` reflect the default Mistral
 * surface:
 *   - `streaming`: supported (SSE)
 *   - `toolUse`  : supported (OpenAI-style function calls)
 *   - `embeddings`: supported (model `mistral-embed`)
 *   - `vision`   : not advertised — Mistral's chat models are text-only
 *
 * @example
 * ```ts
 * import { createMistralProvider } from '@lumen/llm'
 *
 * const provider = createMistralProvider({
 *   apiKey: process.env.MISTRAL_API_KEY!,
 *   defaultModel: 'mistral-large-latest',
 * })
 * ```
 */
export function createMistralProvider(opts: MistralProviderOptions): MistralProvider {
  return new MistralProvider({
    id: opts.id ?? MISTRAL_PROVIDER_ID,
    baseUrl: opts.baseUrl ?? DEFAULT_MISTRAL_BASE_URL,
    apiKey: opts.apiKey,
    defaultModel: opts.defaultModel ?? DEFAULT_MISTRAL_MODEL,
    defaultHeaders: opts.defaultHeaders,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
    embedModel: opts.embedModel,
  })
}
