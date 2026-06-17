/**
 * Provider contract — every LLM backend implements this.
 *
 * The contract is intentionally small (3 methods). Provider-specific quirks
 * (prompt caching, reasoning mode, tool choice forcing) are expressed via
 * {@link ProviderCapabilities} and the `providerOptions` field on
 * {@link ChatRequest}.
 *
 * Why an abstract class, not an interface:
 *   - We get free `instanceof` checks.
 *   - Subclasses can override ONE method (e.g. `chat` only) and inherit
 *     sensible defaults for the others.
 *   - Default implementations can throw "not supported", making it obvious
 *     which providers are embed-only, chat-only, or full.
 */

import type { z } from 'zod'
import { ProviderError } from '../errors/index.js'
import type { ToolDescriptor } from '../tools/index.js'
import type { Message } from './index.js'
import type { AssistantMessage, StreamEvent, StreamOptions } from './index.js'

export interface ProviderCapabilities {
  /** Provider can stream responses incrementally. */
  readonly streaming: boolean
  /** Provider can return embeddings. */
  readonly embeddings: boolean
  /** Provider supports tool/function calling. */
  readonly toolUse: boolean
  /** Provider supports vision (image inputs). */
  readonly vision: boolean
  /** Provider exposes a separate reasoning/chain-of-thought stream. */
  readonly reasoning: boolean
  /** Provider supports prompt caching. */
  readonly promptCaching: boolean
  /** Provider supports structured output (JSON schema enforcement). */
  readonly structuredOutput: boolean
  /** Maximum context window in tokens (informational; not enforced here). */
  readonly maxContextTokens: number
}

export interface ChatRequest {
  /** Ordered list of messages in the conversation. */
  readonly messages: ReadonlyArray<Message>
  /** Model identifier. Must be supported by this provider. */
  readonly model: string
  /** Sampling temperature (0-2). Provider may clamp. */
  readonly temperature?: number
  /** Maximum output tokens. */
  readonly maxTokens?: number
  /** Nucleus sampling. */
  readonly topP?: number
  /** Stop sequences. */
  readonly stop?: ReadonlyArray<string>
  /**
   * Optional Zod schema describing a desired JSON response shape. If set
   * and the provider supports it, the response is validated against the
   * schema. If unsupported, the provider throws.
   */
  readonly responseSchema?: z.ZodType<unknown>
  /**
   * Tools the model may invoke this turn. Providers translate each
   * {@link ToolDescriptor} into the backend's native tool schema
   * (OpenAI `tools`, Anthropic `tools` with `input_schema`, etc.). If
   * omitted, the model receives no tool definitions for this turn.
   */
  readonly tools?: ReadonlyArray<ToolDescriptor>
  /**
   * Bag for provider-specific options. Untyped by design — providers
   * document their own keys.
   */
  readonly providerOptions?: Record<string, unknown>
}

export interface ChatResponse {
  readonly message: AssistantMessage
  /** Provider-specific raw response, for debugging / tracing. */
  readonly raw?: unknown
  /** Wall-clock latency in milliseconds. */
  readonly latencyMs: number
}

export interface EmbedRequest {
  readonly input: ReadonlyArray<string>
  readonly model: string
  readonly dimensions?: number
}

export interface EmbedResponse {
  readonly vectors: ReadonlyArray<ReadonlyArray<number>>
  readonly model: string
  readonly usage?: { inputTokens: number }
}

/**
 * Abstract base for all LLM providers.
 *
 * Lifecycle: subclass sets `id`, `capabilities`; optionally overrides
 * `chat`, `stream`, `embed`. The base provides:
 *   - Identity (id)
 *   - Default `stream` that wraps `chat` (for providers without native streaming)
 *   - Default `embed` that throws (for chat-only providers)
 *   - `validateRequest()` that subclasses can override for early validation
 */
export abstract class BaseProvider {
  /** Stable identifier (e.g. "openai", "anthropic", "ollama"). */
  public abstract readonly id: string

  /** What this provider can do. Subclasses set this in their constructor. */
  public abstract readonly capabilities: ProviderCapabilities

  /**
   * Send a chat request and return a complete response.
   * Throws {@link ProviderError} on failure.
   */
  public abstract chat(request: ChatRequest, options?: StreamOptions): Promise<ChatResponse>

  /**
   * Stream a chat response. Default implementation calls `chat` and
   * synthesizes stream events — providers SHOULD override for token-by-token
   * streaming.
   */
  public async *stream(
    request: ChatRequest,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    const start: AssistantMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [],
    }
    yield { type: 'message_start', message: start }
    try {
      const response = await this.chat(request, options)
      const text = response.message.content ?? ''
      // Synthesize a content_delta for the whole text. Subclasses that
      // support real streaming should NOT use this default.
      if (text.length > 0) {
        yield { type: 'content_delta', delta: text }
      }
      for (const tc of response.message.toolCalls) {
        yield { type: 'tool_call_complete', toolCall: tc }
      }
      yield { type: 'message_complete', message: response.message }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) }
    }
  }

  /**
   * Generate embeddings. Default throws — override in providers that
   * support it (and set `capabilities.embeddings = true`).
   */
  public async embed(_request: EmbedRequest, _options?: StreamOptions): Promise<EmbedResponse> {
    throw new ProviderError(`Provider ${this.id} does not support embeddings`, {
      providerId: this.id,
      retryable: false,
    })
  }

  /**
   * Hook for subclasses to validate a request before sending. The base
   * implementation is a no-op.
   */
  protected validateRequest(_request: ChatRequest): void {
    // intentionally empty
  }
}
