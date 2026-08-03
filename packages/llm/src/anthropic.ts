/**
 * Anthropic Messages API provider.
 *
 * Implements {@link BaseProvider} against Anthropic's `/v1/messages`
 * endpoint (https://docs.anthropic.com/en/api/messages). Covers Claude
 * Sonnet, Opus, Haiku, and any Anthropic-compatible gateway that speaks
 * the same wire format.
 *
 * Protocol notes (differences from the OpenAI-compatible surface):
 *   - POST `{baseUrl}/messages` (no `/chat/completions` suffix).
 *   - Auth via `x-api-key: <key>` (NOT `Authorization: Bearer`).
 *   - The `anthropic-version` header is required on every request.
 *   - The system prompt is a top-level `system` field, not a `system`-role
 *     message in the `messages` array.
 *   - The `messages` array alternates `user` / `assistant` only; tool
 *     results are sent as `user` messages with `tool_result` content
 *     blocks (one block per result).
 *   - Response `content` is an array of blocks: `text` and/or `tool_use`.
 *   - `stop_reason` values are `end_turn` | `max_tokens` | `stop_sequence`
 *     | `tool_use` (note: NOT `stop` / `tool_calls` like OpenAI).
 *   - Streaming uses typed SSE events (`message_start`,
 *     `content_block_start`, `content_block_delta`, `content_block_stop`,
 *     `message_delta`, `message_stop`). Each event includes its own
 *     `type` field in the JSON payload, so the generic SSE chunk parser
 *     can dispatch based on `type` rather than on the SSE `event:` line.
 *   - `max_tokens` is REQUIRED; we default to 4096 if the caller omits it.
 *
 * The provider does **not** embed an embeddings endpoint — the Anthropic
 * Messages API does not expose one. `embed()` throws a `ProviderError`.
 */

import {
  type AssistantMessage,
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  type ContentPart,
  type EmbedRequest,
  type EmbedResponse,
  type ImagePart,
  type Message,
  type ProviderCapabilities,
  ProviderError,
  type RetryConfig,
  type StreamEvent,
  type StreamOptions,
  type TextPart,
  type ToolCall,
  type ToolResult,
  type UserMessage,
  ValidationError,
  withRetry,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from '@lumen/core'
import { z } from 'zod'
import { buildAnthropicSystemBlocks } from './anthropic-marker.js'
import {
  HttpStatusError,
  ResponseShapeError,
  isRetryableStatus,
  parseResponseJson,
} from './errors.js'
import { parseSseChunks } from './openai-compatible.js'

// ---------------------------------------------------------------------------
// Zod schemas for the Anthropic wire format
// ---------------------------------------------------------------------------
//
// The wire format is documented at https://docs.anthropic.com/en/api/messages.
// We keep these schemas tight on required fields and lenient on optional
// fields, because Anthropic has shipped several minor additions (cache
// control, citations, etc.) and we want forward compatibility.

const AnthropicTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})
const AnthropicToolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()).default({}),
})
const AnthropicContentBlockSchema = z.discriminatedUnion('type', [
  AnthropicTextBlockSchema,
  AnthropicToolUseBlockSchema,
])

const AnthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  // Anthropic also reports cache_creation_input_tokens / cache_read_input_tokens
  // on some models; we accept them but don't surface them on the Lumen
  // `usage` shape (which only tracks total prompt/completion tokens).
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
})
const AnthropicMessageResponseSchema = z.object({
  id: z.string().optional(),
  type: z.literal('message').optional(),
  role: z.literal('assistant').optional(),
  model: z.string().optional(),
  content: z.array(AnthropicContentBlockSchema),
  stop_reason: z
    .union([z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']), z.string(), z.null()])
    .optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: AnthropicUsageSchema.optional(),
})

// Streaming event schemas ----------------------------------------------------

const AnthropicStreamMessageStartSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string().optional(),
    model: z.string().optional(),
    role: z.string().optional(),
    usage: AnthropicUsageSchema.optional(),
  }),
})

const AnthropicStreamContentBlockStartSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number().int().nonnegative(),
  content_block: z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({
      type: z.literal('tool_use'),
      id: z.string().min(1),
      name: z.string().min(1),
      input: z.record(z.unknown()).default({}),
    }),
  ]),
})

const AnthropicStreamTextDeltaSchema = z.object({
  type: z.literal('text_delta'),
  text: z.string(),
})
const AnthropicStreamInputJsonDeltaSchema = z.object({
  type: z.literal('input_json_delta'),
  partial_json: z.string(),
})
const AnthropicStreamContentBlockDeltaSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number().int().nonnegative(),
  delta: z.discriminatedUnion('type', [
    AnthropicStreamTextDeltaSchema,
    AnthropicStreamInputJsonDeltaSchema,
  ]),
})

const AnthropicStreamMessageDeltaSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z
      .union([
        z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']),
        z.string(),
        z.null(),
      ])
      .optional(),
    stop_sequence: z.string().nullable().optional(),
  }),
  usage: AnthropicUsageSchema.optional(),
})

/**
 * Discriminated union over every Anthropic streaming event we care about.
 * Events with `type` we don't handle (e.g. `content_block_stop`,
 * `message_stop`, `ping`, `error`) are accepted as raw objects and ignored
 * by the consumer — they're useful for protocol-level logging but don't
 * carry content the agent loop needs.
 */
const AnthropicStreamEventSchema = z.discriminatedUnion('type', [
  AnthropicStreamMessageStartSchema,
  AnthropicStreamContentBlockStartSchema,
  AnthropicStreamContentBlockDeltaSchema,
  AnthropicStreamMessageDeltaSchema,
  z.object({ type: z.literal('content_block_stop'), index: z.number().int().nonnegative() }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('error'), error: z.record(z.unknown()) }),
])

// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------

/**
 * A single text block in the Anthropic `system` array. The
 * `cache_control` marker tells Anthropic to cache the prefix of the
 * system prompt up to and including this block. Only the *last*
 * marker is honored per request, so place it on the final block of
 * the prefix you want cached.
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
export interface AnthropicSystemBlock {
  readonly type: 'text'
  readonly text: string
  readonly cache_control?: AnthropicCacheControl
}

/**
 * `cache_control` marker. Today only `type: 'ephemeral'` (5-minute
 * cache) is supported by Anthropic; the union is kept narrow so a
 * future `type: 'persistent'` addition can extend without breaking
 * the public type.
 */
export interface AnthropicCacheControl {
  readonly type: 'ephemeral'
}

/** Zod schema for a single system block; used at runtime to validate
 *  whatever the caller put in `providerOptions`. */
const AnthropicSystemBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: z.object({ type: z.literal('ephemeral') }).optional(),
})

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Default Anthropic API version. Anthropic dates its API versions
 * (e.g. `2023-06-01`, `2024-01-01`, `2025-01-01`). We pin to a recent
 * stable; callers can override via {@link AnthropicOptions.anthropicVersion}.
 */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/** Default `max_tokens` for requests that don't supply one. Anthropic requires it. */
export const DEFAULT_MAX_TOKENS = 4096

/**
 * Constructor options for {@link AnthropicProvider}.
 *
 * `baseUrl` defaults to the public Anthropic endpoint but is **always
 * overridable** — useful for corporate proxies, self-hosted gateways,
 * or third-party Anthropic-compatible APIs (e.g. AWS Bedrock's adapter).
 */
export interface AnthropicOptions {
  /** Stable identifier reported via `BaseProvider.id`. Defaults to `'anthropic'`. */
  readonly id?: string
  /** Base URL of the API, e.g. `https://api.anthropic.com/v1`. No trailing slash. */
  readonly baseUrl: string
  /** Anthropic API key. Sent verbatim as `x-api-key`. */
  readonly apiKey: string
  /** Default model id, used when a request omits `model`. */
  readonly defaultModel: string
  /** Anthropic API version header. Defaults to `2023-06-01`. */
  readonly anthropicVersion?: string
  /** Default `max_tokens` when the caller omits one. Defaults to 4096. */
  readonly defaultMaxTokens?: number
  /** Extra headers merged into every request (e.g. tracing ids). */
  readonly defaultHeaders?: Readonly<Record<string, string>>
  /** Per-request timeout in milliseconds. Defaults to 60s. */
  readonly timeoutMs?: number
  /** Capabilities override. */
  readonly capabilities?: Partial<ProviderCapabilities>
  /** Inject a custom fetch implementation (used by tests). */
  readonly fetchImpl?: typeof fetch
  /**
   * Retry policy for transient HTTP failures (5xx, 408, 429). Defaults
   * to no retry.
   */
  readonly retry?: RetryConfig
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function defaultCapabilities(): ProviderCapabilities {
  return {
    streaming: true,
    embeddings: false,
    toolUse: true,
    vision: true,
    reasoning: false,
    promptCaching: true,
    structuredOutput: false,
    // Anthropic Claude 3.x / 4.x family: 200k context window
    maxContextTokens: 200_000,
  }
}

/**
 * Split a flat message list into the top-level `system` field and the
 * `messages` array. Anthropic takes the system prompt out of the message
 * stream; the rest of the messages must alternate `user` / `assistant`.
 *
 * Two shapes of `system` are supported:
 *   - string (default) — multiple consecutive system messages are
 *     joined with a blank line. Used when the caller did not opt
 *     into prompt caching.
 *   - structured blocks — used when the caller passes
 *     `request.providerOptions.anthropicSystemBlocks`. Each block
 *     may carry a `cache_control: { type: 'ephemeral' }` marker so
 *     Anthropic caches the prefix of the system prompt across
 *     requests. An empty array is treated as "no system prompt" and
 *     drops the `system` field from the body entirely.
 */
function splitSystemAndMessages(
  messages: ReadonlyArray<Message>,
  systemBlocks?: ReadonlyArray<AnthropicSystemBlock>,
): {
  system: string | ReadonlyArray<AnthropicSystemBlock> | undefined
  anthropicMessages: Array<Record<string, unknown>>
} {
  const systemParts: string[] = []
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    switch (m.role) {
      case 'system': {
        systemParts.push(m.content)
        break
      }
      case 'user': {
        out.push({ role: 'user', content: userContentToAnthropic(m) })
        break
      }
      case 'assistant': {
        out.push({ role: 'assistant', content: assistantContentToAnthropic(m) })
        break
      }
      case 'tool': {
        // Anthropic has no `role: "tool"`. Each tool result becomes a
        // `tool_result` content block within a single `user` message.
        // If the previous message was already a user message we could
        // merge them, but emitting one user message per tool-result
        // batch is simpler and still protocol-conformant.
        out.push({ role: 'user', content: toolResultsToAnthropic(m.results) })
        break
      }
    }
  }
  // When the caller supplied structured system blocks, those take
  // precedence over the implicit system-prompt string from the
  // messages. We do not concatenate the two — Anthropic treats the
  // explicit blocks as the canonical system prompt and the implicit
  // string would just bloat the wire size without being cacheable.
  if (systemBlocks !== undefined) {
    return { system: systemBlocks.length === 0 ? undefined : systemBlocks, anthropicMessages: out }
  }
  const system = systemParts.length === 0 ? undefined : systemParts.join('\n\n')
  return { system, anthropicMessages: out }
}

function userContentToAnthropic(m: UserMessage): string | Array<Record<string, unknown>> {
  if (typeof m.content === 'string') return m.content
  return m.content.map((p: ContentPart) => contentPartToAnthropic(p))
}

function contentPartToAnthropic(p: ContentPart): Record<string, unknown> {
  if (p.type === 'text') {
    const part: TextPart = p
    return { type: 'text', text: part.text }
  }
  const img: ImagePart = p
  if (img.source.kind === 'url') {
    return {
      type: 'image',
      source: { type: 'url', url: img.source.url },
    }
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.source.mediaType,
      data: img.source.data,
    },
  }
}

function assistantContentToAnthropic(m: AssistantMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = []
  if (m.content !== undefined && m.content.length > 0) {
    blocks.push({ type: 'text', text: m.content })
  }
  for (const tc of m.toolCalls) {
    blocks.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.name,
      input: tc.arguments,
    })
  }
  return blocks
}

function toolResultsToAnthropic(
  results: ReadonlyArray<ToolResult>,
): Array<Record<string, unknown>> {
  return results.map((r) => {
    if (r.isError) {
      return {
        type: 'tool_result',
        tool_use_id: r.toolCallId,
        content: r.content ?? `Error: ${r.toolCallId}`,
        is_error: true,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: r.toolCallId,
      content: r.content ?? '',
    }
  })
}

/** Map an Anthropic `stop_reason` to a Lumen `finishReason`. */
function mapStopReason(reason: string | null | undefined): AssistantMessage['finishReason'] {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  return undefined
}

function mapUsage(
  usage: z.infer<typeof AnthropicUsageSchema> | undefined,
): AssistantMessage['usage'] {
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.input_tokens + usage.output_tokens,
  }
}

/** Build the Lumen `AssistantMessage` from a parsed Anthropic response. */
function responseToAssistantMessage(
  parsed: z.infer<typeof AnthropicMessageResponseSchema>,
  fallbackModel: string,
): AssistantMessage {
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []
  for (const block of parsed.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      })
    }
  }
  const content = textParts.length > 0 ? textParts.join('') : undefined
  const finishReason = mapStopReason(parsed.stop_reason)
  const usage = mapUsage(parsed.usage)
  return {
    role: 'assistant',
    ...(content !== undefined ? { content } : {}),
    toolCalls,
    ...(parsed.model ? { model: parsed.model } : { model: fallbackModel }),
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * {@link BaseProvider} implementation that talks to Anthropic's Messages
 * API. Supports text, images, tool use, system prompts, and streaming.
 */
export class AnthropicProvider extends BaseProvider {
  public override readonly id: string
  public override readonly capabilities: ProviderCapabilities

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultModel: string
  private readonly anthropicVersion: string
  private readonly defaultMaxTokens: number
  private readonly defaultHeaders: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly retry: RetryConfig | undefined

  constructor(options: AnthropicOptions) {
    super()
    if (!options.baseUrl || options.baseUrl.length === 0) {
      throw new ValidationError('AnthropicProvider: `baseUrl` is required', { field: 'baseUrl' })
    }
    if (!options.apiKey || options.apiKey.length === 0) {
      throw new ValidationError('AnthropicProvider: `apiKey` is required', { field: 'apiKey' })
    }
    if (!options.defaultModel || options.defaultModel.length === 0) {
      throw new ValidationError('AnthropicProvider: `defaultModel` is required', {
        field: 'defaultModel',
      })
    }
    this.id = options.id ?? 'anthropic'
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.apiKey = options.apiKey
    this.defaultModel = options.defaultModel
    this.anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS
    this.defaultHeaders = options.defaultHeaders ?? {}
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.retry = options.retry
    this.fetchImpl =
      options.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as typeof fetch)
        : (() => {
            throw new ValidationError(
              'AnthropicProvider: no fetch implementation available. Pass `fetchImpl` or run on Node 20+.',
              { field: 'fetchImpl' },
            )
          })())
    this.capabilities = { ...defaultCapabilities(), ...(options.capabilities ?? {}) }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  public override async chat(request: ChatRequest, options?: StreamOptions): Promise<ChatResponse> {
    this.validateRequest(request)
    const start = Date.now()
    const body = this.buildRequestBody(request, /* stream */ false)
    const response = await this.performFetch('/messages', body, options)
    const text = await response.text()
    if (!response.ok) {
      throw this.makeHttpError(response.status, text)
    }
    const parsed = parseResponseJson(text, AnthropicMessageResponseSchema)
    const message = responseToAssistantMessage(parsed, request.model)
    return {
      message,
      raw: parsed,
      latencyMs: Date.now() - start,
    }
  }

  public override async *stream(
    request: ChatRequest,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    this.validateRequest(request)
    const body = this.buildRequestBody(request, /* stream */ true)
    const response = await this.performFetch('/messages', body, options)
    if (!response.ok) {
      const text = await response.text()
      throw this.makeHttpError(response.status, text)
    }
    if (!response.body) {
      throw new ProviderError('Anthropic provider returned empty body for streaming', {
        providerId: this.id,
        retryable: false,
      })
    }

    yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }

    // Per-content-block accumulators. The Anthropic streaming protocol
    // indexes content blocks (0, 1, 2, …) within a single message; we
    // track text buffers and (for tool_use blocks) partial JSON buffers
    // keyed by that index.
    interface ToolAcc {
      id: string
      name: string
      args: string
    }
    const textAcc = new Map<number, string>()
    const toolAcc = new Map<number, ToolAcc>()
    let finishReason: AssistantMessage['finishReason']
    let modelName: string | undefined
    let outputTokens: number | undefined
    const completedToolCalls: ToolCall[] = []
    const textBlocks: string[] = []

    try {
      for await (const chunk of parseSseChunks(response.body)) {
        const parsed = parseResponseJson(chunk, AnthropicStreamEventSchema)
        switch (parsed.type) {
          case 'message_start': {
            if (parsed.message.model) modelName = parsed.message.model
            if (parsed.message.usage) {
              outputTokens = parsed.message.usage.output_tokens
            }
            break
          }
          case 'content_block_start': {
            if (parsed.content_block.type === 'tool_use') {
              toolAcc.set(parsed.index, {
                id: parsed.content_block.id,
                name: parsed.content_block.name,
                args: '',
              })
            }
            break
          }
          case 'content_block_delta': {
            if (parsed.delta.type === 'text_delta') {
              textAcc.set(parsed.index, (textAcc.get(parsed.index) ?? '') + parsed.delta.text)
              yield { type: 'content_delta', delta: parsed.delta.text }
            } else if (parsed.delta.type === 'input_json_delta') {
              const acc = toolAcc.get(parsed.index)
              if (acc) {
                acc.args += parsed.delta.partial_json
                yield {
                  type: 'tool_call_delta',
                  id: acc.id,
                  name: acc.name,
                  argumentsDelta: parsed.delta.partial_json,
                }
              }
            }
            break
          }
          case 'content_block_stop': {
            // If a text block finished, snapshot it for the final message.
            // If a tool_use block finished, parse the accumulated JSON and
            // emit a `tool_call_complete` event.
            const tool = toolAcc.get(parsed.index)
            if (tool) {
              let args: Record<string, unknown> = {}
              if (tool.args.length > 0) {
                try {
                  const parsed_args: unknown = JSON.parse(tool.args)
                  if (
                    parsed_args &&
                    typeof parsed_args === 'object' &&
                    !Array.isArray(parsed_args)
                  ) {
                    args = parsed_args as Record<string, unknown>
                  }
                } catch (cause) {
                  throw new ProviderError(
                    `Anthropic provider streamed invalid JSON in tool_use input for ${tool.id}`,
                    { providerId: this.id, retryable: false, cause },
                  )
                }
              }
              const toolCall: ToolCall = { id: tool.id, name: tool.name, arguments: args }
              completedToolCalls.push(toolCall)
              yield { type: 'tool_call_complete', toolCall }
            } else if (textAcc.has(parsed.index)) {
              // Snapshot the text block in order. We sort by index so the
              // final `content` matches the order in which blocks started.
              const idx = parsed.index
              textBlocks[idx] = textAcc.get(idx) ?? ''
            }
            break
          }
          case 'message_delta': {
            if (parsed.delta.stop_reason) {
              finishReason = mapStopReason(parsed.delta.stop_reason)
            }
            if (parsed.usage) {
              outputTokens = parsed.usage.output_tokens
            }
            break
          }
          case 'message_stop':
          case 'ping':
            break
          case 'error': {
            const errMsg =
              typeof parsed.error === 'object' && parsed.error && 'message' in parsed.error
                ? String((parsed.error as { message: unknown }).message)
                : 'Anthropic streaming returned an error event'
            throw new ProviderError(errMsg, { providerId: this.id, retryable: false })
          }
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err
      if (err instanceof ResponseShapeError) {
        throw new ProviderError(err.message, { providerId: this.id, retryable: false, cause: err })
      }
      throw err
    }

    // Synthesize the final AssistantMessage.
    // For text, concatenate blocks in the order they were emitted.
    const finalText = textBlocks
      .filter((b) => b !== undefined)
      .join('')
      .trim()
    const finalMessage: AssistantMessage = {
      role: 'assistant',
      ...(finalText.length > 0 ? { content: finalText } : {}),
      toolCalls: completedToolCalls,
      ...(modelName ? { model: modelName } : { model: request.model }),
      ...(finishReason ? { finishReason } : {}),
      ...(outputTokens !== undefined
        ? {
            usage: {
              // input_tokens is reported on message_start; we capture it
              // separately if it ever arrives in a delta (some Anthropic
              // versions only emit it on message_start).
              inputTokens: 0,
              outputTokens,
              totalTokens: outputTokens,
            },
          }
        : {}),
    }
    yield { type: 'message_complete', message: finalMessage }
  }

  public override async embed(
    _request: EmbedRequest,
    _options?: StreamOptions,
  ): Promise<EmbedResponse> {
    throw new ProviderError(
      `Provider ${this.id} does not implement embeddings via the Anthropic Messages API`,
      { providerId: this.id, retryable: false },
    )
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    if (!request.model || request.model.length === 0) {
      throw new ProviderError('ChatRequest.model is required', {
        providerId: this.id,
        retryable: false,
      })
    }
    // Resolve structured system blocks from providerOptions, validate
    // the shape (so a typo in `cache_control.type` fails fast at
    // request time rather than 400ing on the wire), and hand them to
    // the splitter. An invalid shape throws a typed ProviderError.
    const systemBlocks = this.resolveSystemBlocks(request)
    const { system, anthropicMessages } = splitSystemAndMessages(request.messages, systemBlocks)
    // P31.5 — when `system` is a string that carries the cache-
    // boundary marker, rewrite it into a two-block array so
    // Anthropic can cache the stable prefix and skip the
    // dynamic suffix on every turn. Caller-supplied structured
    // blocks still win when present (per the existing precedence
    // rule). Per design doc §1.8, only Anthropic benefits from
    // this in v1.
    let resolvedSystem: string | ReadonlyArray<AnthropicSystemBlock> | undefined = system
    if (
      typeof system === 'string' &&
      system.includes(SYSTEM_PROMPT_CACHE_BOUNDARY) &&
      systemBlocks === undefined
    ) {
      resolvedSystem = buildAnthropicSystemBlocks(system)
    }
    if (anthropicMessages.length === 0) {
      throw new ProviderError('Anthropic requires at least one non-system message in `messages`', {
        providerId: this.id,
        retryable: false,
      })
    }
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: anthropicMessages,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
    }
    if (resolvedSystem !== undefined) body.system = resolvedSystem
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.topP !== undefined) body.top_p = request.topP
    if (request.stop !== undefined && request.stop.length > 0) {
      body.stop_sequences = request.stop.length === 1 ? request.stop[0] : [...request.stop]
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t, i) => {
        const toolBody: Record<string, unknown> = {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          // Anthropic takes a JSON Schema object directly as `input_schema`,
          // not a wrapped `parameters` envelope like OpenAI does.
          input_schema: t.inputJsonSchema ?? { type: 'object', properties: {} },
        }
        // Prompt-caching marker on a tool definition. Anthropic caches
        // the tool definition prefix up to and including the marked
        // tool; place the marker on the last tool whose definition
        // you want to cache.
        const cacheTools = this.resolveToolCacheControl(request)
        if (cacheTools.includes(i)) {
          toolBody.cache_control = { type: 'ephemeral' }
        }
        return toolBody
      })
    }
    if (stream) body.stream = true
    return body
  }

  /**
   * Pull `providerOptions.anthropicSystemBlocks` out of the request
   * and validate each block. Returns `undefined` when the key is
   * absent so the splitter falls back to the string-join path.
   */
  private resolveSystemBlocks(
    request: ChatRequest,
  ): ReadonlyArray<AnthropicSystemBlock> | undefined {
    const raw = request.providerOptions?.anthropicSystemBlocks
    if (raw === undefined) return undefined
    const parsed = z.array(AnthropicSystemBlockSchema).safeParse(raw)
    if (!parsed.success) {
      throw new ProviderError(
        `Invalid anthropicSystemBlocks: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        { providerId: this.id, retryable: false },
      )
    }
    return parsed.data as ReadonlyArray<AnthropicSystemBlock>
  }

  /**
   * Pull `providerOptions.anthropicCacheTools` (a list of tool
   * indices) out of the request. Indices that are out of range are
   * silently dropped — the caller may not know the filtered list
   * size, and we'd rather cache a strict subset than throw.
   */
  private resolveToolCacheControl(request: ChatRequest): ReadonlyArray<number> {
    const raw = request.providerOptions?.anthropicCacheTools
    if (raw === undefined || !Array.isArray(raw)) return []
    return raw.filter((v): v is number => typeof v === 'number' && Number.isInteger(v))
  }

  private async performFetch(
    path: string,
    body: unknown,
    options?: StreamOptions,
  ): Promise<Response> {
    const doFetch = async (): Promise<Response> => {
      const url = `${this.baseUrl}${path}`
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
        ...this.defaultHeaders,
        ...(options?.headers ?? {}),
      }
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('request timeout')),
        this.timeoutMs,
      )
      const signal = options?.signal
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timeout)
          throw new DOMException('Aborted', 'AbortError')
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
      }
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        // See ollama.ts for rationale: throw ProviderError here so
        // withRetry can re-issue on transient HTTP failures.
        if (this.retry && !response.ok) {
          const text = await response.text()
          throw this.makeHttpError(response.status, text)
        }
        return response
      } finally {
        clearTimeout(timeout)
      }
    }
    if (this.retry) {
      return withRetry(doFetch, { ...this.retry, signal: options?.signal })
    }
    return doFetch()
  }

  private makeHttpError(status: number, body: string): ProviderError {
    const retryable = isRetryableStatus(status)
    const upstreamMessage = extractAnthropicErrorMessage(body)
    return new ProviderError(upstreamMessage ?? `Anthropic provider returned HTTP ${status}`, {
      providerId: this.id,
      statusCode: status,
      retryable,
      cause: new HttpStatusError(status, body, retryable),
    })
  }
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

/** Pull a friendly `error.message` out of an Anthropic-style error body. */
function extractAnthropicErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error
      if (err && typeof err === 'object' && 'message' in err) {
        const msg = (err as { message: unknown }).message
        if (typeof msg === 'string') return msg
      }
    }
  } catch {
    // fall through
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Convenience factory: build an {@link AnthropicProvider} pointed at the
 * public Anthropic endpoint.
 */
export function createAnthropicProvider(opts: {
  readonly apiKey: string
  readonly defaultModel: string
  readonly id?: string
  readonly baseUrl?: string
  readonly anthropicVersion?: string
  readonly defaultMaxTokens?: number
  readonly defaultHeaders?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}): AnthropicProvider {
  return new AnthropicProvider({
    id: opts.id ?? 'anthropic',
    baseUrl: opts.baseUrl ?? 'https://api.anthropic.com/v1',
    apiKey: opts.apiKey,
    defaultModel: opts.defaultModel,
    anthropicVersion: opts.anthropicVersion,
    defaultMaxTokens: opts.defaultMaxTokens,
    defaultHeaders: opts.defaultHeaders,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  })
}
