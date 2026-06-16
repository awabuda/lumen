/**
 * Ollama provider.
 *
 * Implements {@link BaseProvider} against Ollama's `/api/chat`,
 * `/api/embed`, and `/api/embeddings` endpoints
 * (https://github.com/ollama/ollama/blob/main/docs/api.md). Covers any
 * locally-running Ollama server (default `http://127.0.0.1:11434`) and
 * any Ollama-compatible gateway that speaks the same wire format.
 *
 * Protocol notes (differences from the OpenAI surface):
 *   - POST `{baseUrl}/api/chat` (not `/v1/chat/completions`).
 *   - No `Authorization` header by default. Ollama is a local server and
 *     doesn't require auth, but if the caller supplies an `apiKey` we
 *     attach it as `Authorization: Bearer …` for proxied deployments.
 *   - Image parts on user messages become a top-level `images: string[]`
 *     field of base64 payloads on the message object, not OpenAI's
 *     `image_url` content blocks.
 *   - Tool definitions use a flat `{type:'function', function:{name,
 *     description, parameters}}` shape (similar to OpenAI), but Ollama
 *     v0.5+ has stricter naming — we use `type: 'function'` and pass the
 *     JSON Schema under `function.parameters`.
 *   - Tool calls in responses live on `message.tool_calls` with each
 *     entry already containing a parsed `function.arguments` OBJECT (not
 *     a JSON string like OpenAI). We pass it through unchanged.
 *   - `done_reason` is `'stop'` | `'load'` | `'unload'` (Ollama-flavored);
 *     we map `'stop'` to Lumen `'stop'`, anything else to `undefined`.
 *   - Usage is reported as `prompt_eval_count` / `eval_count` /
 *     `total_duration` / `load_duration` / `prompt_eval_duration` /
 *     `eval_duration`. We surface input/output/total tokens on
 *     `usage` and discard the timings (they're for client telemetry, not
 *     the agent loop).
 *   - Streaming uses NDJSON (newline-delimited JSON), NOT SSE. Each line
 *     is a full JSON object; the final line has `done: true` and may
 *     include usage/timing fields. We use a generic `parseNdjson` helper
 *     because `parseSseChunks` would mis-parse the lines.
 *   - Embeddings use `/api/embed` (newer, takes `input: string[]`) when
 *     `useLegacyEmbeddings` is false (default), and `/api/embeddings`
 *     (legacy, takes `prompt: string`) when true. The legacy endpoint
 *     only accepts a single string; we therefore issue one request per
 *     input string and concatenate.
 *
 * The provider supports all of: text, multimodal (image), tool use,
 * streaming, and embeddings. It does NOT support prompt caching
 * (Ollama is purely local), structured output via JSON Schema
 * (`format: <schema>` IS supported but we don't expose it through
 * `ChatRequest.responseSchema` yet — that lands with K3.x), reasoning
 * (no extended thinking), or any auth beyond the optional bearer.
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
  type ToolDescriptor,
  type UserMessage,
  withRetry,
} from '@lumen/core'
import { z } from 'zod'
import {
  HttpStatusError,
  ResponseShapeError,
  isRetryableStatus,
  parseResponseJson,
} from './errors.js'

// ---------------------------------------------------------------------------
// Zod schemas for the Ollama wire format
// ---------------------------------------------------------------------------
//
// Spec reference: https://github.com/ollama/ollama/blob/main/docs/api.md.
// We keep these tight on required fields and lenient on optional ones,
// because Ollama adds new fields frequently (timings, KV cache stats, etc.)
// and we want forward compatibility.

const OllamaTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})

const OllamaImagePartSchema = z.object({
  type: z.literal('image'),
  // Ollama takes raw base64 (no `data:` prefix, no media type).
  source: z.union([
    z.object({ kind: z.literal('url'), url: z.string() }),
    z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
  ]),
})

const OllamaUserContentPartSchema = z.discriminatedUnion('type', [
  OllamaTextPartSchema,
  OllamaImagePartSchema,
])

const OllamaUserMessageSchema = z.object({
  role: z.literal('user'),
  content: z.union([z.string(), z.array(OllamaUserContentPartSchema)]),
  // Ollama also accepts pre-rendered `images: string[]` on the message.
  // We always emit `content: [{type:'image', source:…}]` and let
  // `messagesToOllama` lift images into the `images` field.
})

const OllamaAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().optional(),
  // Tool calls are only present when the model decides to call a tool.
  tool_calls: z
    .array(
      z.object({
        // Ollama v0.5+ returns objects with this shape; v0.3 / v0.4 may
        // omit the `function` envelope. We accept both.
        function: z
          .object({
            name: z.string().min(1),
            // Ollama already parses `arguments` into an object — unlike
            // OpenAI, which returns a JSON string.
            arguments: z.record(z.unknown()).default({}),
          })
          .optional(),
      }),
    )
    .optional(),
})

const OllamaSystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
})

// Ollama's "tool" role is unofficial but supported by the local server
// for round-tripping results back to the model. We accept it but also
// support folding tool results into the next user message (mirroring
// Anthropic's protocol) for older models that don't accept `role:tool`.
const OllamaToolResultMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.string(),
})

const OllamaMessageSchema = z.union([
  OllamaSystemMessageSchema,
  OllamaUserMessageSchema,
  OllamaAssistantMessageSchema,
  OllamaToolResultMessageSchema,
])

const OllamaUsageSchema = z.object({
  // Token counts. Older versions of Ollama only emit these on the final
  // `done:true` chunk; newer versions emit them on every chunk.
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  // Timing fields. We accept and ignore them — they're for client
  // telemetry, not the agent loop.
  total_duration: z.number().nonnegative().optional(),
  load_duration: z.number().nonnegative().optional(),
  prompt_eval_duration: z.number().nonnegative().optional(),
  eval_duration: z.number().nonnegative().optional(),
})

const OllamaChatResponseSchema = z.object({
  model: z.string().optional(),
  created_at: z.string().optional(),
  // Final response includes `done: true`; intermediate streaming chunks
  // (which we also accept in non-streaming mode for forward compat)
  // include `done: false`.
  done: z.boolean().optional(),
  done_reason: z.string().nullable().optional(),
  message: OllamaAssistantMessageSchema,
  // Usage can be absent on intermediate chunks; final chunk usually has it.
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  total_duration: z.number().nonnegative().optional(),
  load_duration: z.number().nonnegative().optional(),
  prompt_eval_duration: z.number().nonnegative().optional(),
  eval_duration: z.number().nonnegative().optional(),
})

const OllamaEmbedResponseSchema = z.object({
  model: z.string().optional(),
  // Newer endpoint (`/api/embed`): array of vectors.
  embeddings: z.array(z.array(z.number())).optional(),
  // Legacy endpoint (`/api/embeddings`): single vector.
  embedding: z.array(z.number()).optional(),
})

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Default Ollama endpoint. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'

/**
 * Constructor options for {@link OllamaProvider}.
 *
 * `baseUrl` defaults to the local Ollama server but is always overridable
 * — useful for remote Ollama instances, proxies, or tests.
 */
export interface OllamaOptions {
  /** Stable identifier reported via `BaseProvider.id`. Defaults to `'ollama'`. */
  readonly id?: string
  /** Base URL of the Ollama server, e.g. `http://127.0.0.1:11434`. No trailing slash. */
  readonly baseUrl?: string
  /**
   * Optional bearer token. Ollama by default runs unauthenticated locally,
   * but proxies and remote deployments may require auth. Empty string is
   * equivalent to omitting.
   */
  readonly apiKey?: string
  /** Default model id, used when a request omits `model`. */
  readonly defaultModel: string
  /** Extra headers merged into every request (e.g. tracing ids). */
  readonly defaultHeaders?: Readonly<Record<string, string>>
  /** Per-request timeout in milliseconds. Defaults to 120s (Ollama can be slow on first load). */
  readonly timeoutMs?: number
  /**
   * Use the legacy `/api/embeddings` endpoint (single-prompt only)
   * instead of the newer `/api/embed` (batch). Defaults to false.
   * Set to true for Ollama < 0.1.27 or any server that doesn't yet
   * support the batch endpoint.
   */
  readonly useLegacyEmbeddings?: boolean
  /** Capabilities override. */
  readonly capabilities?: Partial<ProviderCapabilities>
  /** Inject a custom fetch implementation (used by tests). */
  readonly fetchImpl?: typeof fetch
  /**
   * Retry policy for transient HTTP failures (5xx, 408, 429). Defaults
   * to no retry — supply `maxAttempts: 3` (etc.) to opt in. The
   * {@link ProviderError.retryable} flag set by `makeHttpError` drives
   * the loop, so non-retryable 4xx responses short-circuit immediately.
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
    embeddings: true,
    toolUse: true,
    vision: true,
    reasoning: false,
    promptCaching: false,
    structuredOutput: false,
    // Ollama context length depends on the model. 8k is a conservative
    // default that covers llama3.1, mistral, qwen2.5, gemma2 out of the
    // box. Callers can override via `capabilities.maxContextTokens`.
    maxContextTokens: 8_192,
  }
}

/**
 * Map an Ollama `done_reason` to a Lumen `finishReason`.
 *
 * Ollama always sends `done_reason: 'stop'` even when the response
 * contains tool calls — its wire format doesn't have a separate
 * `'tool_use'` enum. We therefore take the presence of `tool_calls`
 * into account: if the model returned tool calls, the Lumen-side
 * finishReason is `'tool_calls'` regardless of what Ollama said.
 */
function mapDoneReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): AssistantMessage['finishReason'] {
  if (hasToolCalls) return 'tool_calls'
  if (reason === 'stop') return 'stop'
  // `'load'` / `'unload'` / `null` are Ollama-internal lifecycle signals
  // we don't surface to the agent loop.
  return undefined
}

function mapUsage(
  promptEval: number | undefined,
  evalCount: number | undefined,
): AssistantMessage['usage'] {
  if (promptEval === undefined && evalCount === undefined) return undefined
  const input = promptEval ?? 0
  const output = evalCount ?? 0
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
  }
}

/**
 * Convert Lumen `Message`s to Ollama's `messages` array.
 *
 * The mapping rules:
 *   - `system` → `role:system`
 *   - `user` (string) → `role:user, content:string`
 *   - `user` (parts) → `role:user, content:string-or-parts` with any
 *     image parts ALSO lifted into the message-level `images: string[]`
 *     field (Ollama wants raw base64 there, no media type prefix)
 *   - `assistant` → `role:assistant, content?, tool_calls?:[…]`
 *   - `tool` → fold each result into a `role:tool` message with
 *     `content: result.content ?? ''`
 */
function messagesToOllama(messages: ReadonlyArray<Message>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    switch (m.role) {
      case 'system': {
        out.push({ role: 'system', content: m.content })
        break
      }
      case 'user': {
        if (typeof m.content === 'string') {
          out.push({ role: 'user', content: m.content })
        } else {
          const text = m.content
            .filter((p): p is TextPart => p.type === 'text')
            .map((p) => p.text)
            .join('')
          const images = m.content
            .filter((p): p is ImagePart => p.type === 'image')
            .map((p) => ollamaImageSource(p))
            .filter((s): s is string => s !== undefined)
          const msg: Record<string, unknown> = { role: 'user', content: text }
          if (images.length > 0) msg.images = images
          out.push(msg)
        }
        break
      }
      case 'assistant': {
        const msg: Record<string, unknown> = { role: 'assistant' }
        if (m.content !== undefined && m.content.length > 0) msg.content = m.content
        if (m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          }))
        }
        out.push(msg)
        break
      }
      case 'tool': {
        // Ollama accepts `role: 'tool'` for tool results; one message
        // per result, mirroring OpenAI's behavior.
        for (const r of m.results) {
          out.push({
            role: 'tool',
            content: r.isError ? (r.content ?? `Error: ${r.toolCallId}`) : (r.content ?? ''),
          })
        }
        break
      }
    }
  }
  return out
}

/** Resolve an image part to a raw base64 string. URL-typed images are skipped. */
function ollamaImageSource(p: ImagePart): string | undefined {
  if (p.source.kind === 'base64') {
    // Strip an optional `data:<mediatype>;base64,` prefix if the caller
    // accidentally included one — Ollama wants only the base64 payload.
    const raw = p.source.data
    const comma = raw.indexOf(',')
    return comma >= 0 ? raw.slice(comma + 1) : raw
  }
  // Ollama doesn't fetch URLs server-side; skip url-typed images.
  return undefined
}

/** Convert a parsed Ollama response into a Lumen `AssistantMessage`. */
function responseToAssistantMessage(
  parsed: z.infer<typeof OllamaChatResponseSchema>,
  fallbackModel: string,
): AssistantMessage {
  const msg = parsed.message
  const text = msg.content
  const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
    .map((tc, idx) => {
      // Ollama v0.5+ wraps in `function:{name, arguments}`. v0.3/v0.4
      // sometimes returns `name`+`arguments` flat. Accept both.
      const fn = tc.function
      const name = fn?.name
      if (!name) return undefined
      return {
        // Ollama doesn't always assign a stable id. Synthesize one so
        // the agent loop can correlate tool calls with their results.
        id: `ollama_call_${idx}_${Date.now()}`,
        name,
        arguments: fn.arguments,
      }
    })
    .filter((tc): tc is ToolCall => tc !== undefined)
  return {
    role: 'assistant',
    ...(text !== undefined && text.length > 0 ? { content: text } : {}),
    toolCalls,
    ...(parsed.model ? { model: parsed.model } : { model: fallbackModel }),
    ...(mapDoneReason(parsed.done_reason, toolCalls.length > 0)
      ? { finishReason: mapDoneReason(parsed.done_reason, toolCalls.length > 0)! }
      : {}),
    ...(mapUsage(parsed.prompt_eval_count, parsed.eval_count)
      ? { usage: mapUsage(parsed.prompt_eval_count, parsed.eval_count)! }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// NDJSON line parser (replaces SSE for the Ollama streaming surface)
// ---------------------------------------------------------------------------

/**
 * Parse a streamed Ollama response body into one JSON-string line per
 * yielded value. Ollama's wire format is NDJSON (newline-delimited),
 * NOT SSE, so the OpenAI `parseSseChunks` helper would mis-parse it.
 */
export async function* parseNdjsonLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // NDJSON events are separated by `\n`. We split on `\n` and keep
      // the tail in the buffer in case a boundary straddles a chunk.
      let boundary = buffer.indexOf('\n')
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        if (line.length > 0) yield line
        boundary = buffer.indexOf('\n')
      }
    }
    // Drain anything left in the buffer.
    const tail = buffer.trim()
    if (tail.length > 0) yield tail
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * {@link BaseProvider} implementation that talks to a local (or proxied)
 * Ollama server. Supports text, images, tool use, streaming, and
 * embeddings.
 */
export class OllamaProvider extends BaseProvider {
  public override readonly id: string
  public override readonly capabilities: ProviderCapabilities

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultModel: string
  private readonly defaultHeaders: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly useLegacyEmbeddings: boolean
  private readonly fetchImpl: typeof fetch
  private readonly retry: RetryConfig | undefined

  constructor(options: OllamaOptions) {
    super()
    if (!options.defaultModel || options.defaultModel.length === 0) {
      throw new Error('OllamaProvider: `defaultModel` is required')
    }
    this.id = options.id ?? 'ollama'
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL)
    this.apiKey = options.apiKey ?? ''
    this.defaultModel = options.defaultModel
    this.defaultHeaders = options.defaultHeaders ?? {}
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.useLegacyEmbeddings = options.useLegacyEmbeddings ?? false
    this.retry = options.retry
    this.fetchImpl =
      options.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as typeof fetch)
        : (() => {
            throw new Error(
              'OllamaProvider: no fetch implementation available. Pass `fetchImpl` or run on Node 20+.',
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
    const body = this.buildChatRequestBody(request, /* stream */ false)
    const response = await this.performFetch('/api/chat', body, options)
    const text = await response.text()
    if (!response.ok) {
      throw this.makeHttpError(response.status, text)
    }
    const parsed = parseResponseJson(text, OllamaChatResponseSchema)
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
    const body = this.buildChatRequestBody(request, /* stream */ true)
    const response = await this.performFetch('/api/chat', body, options)
    if (!response.ok) {
      const text = await response.text()
      throw this.makeHttpError(response.status, text)
    }
    if (!response.body) {
      throw new ProviderError('Ollama provider returned empty body for streaming', {
        providerId: this.id,
        retryable: false,
      })
    }

    yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }

    // Ollama's streaming protocol sends one NDJSON line per chunk; each
    // line has `message.content` (incremental text) and a `done` flag.
    // Unlike OpenAI/Anthropic, tool calls do NOT stream incrementally —
    // Ollama only emits them on the final `done:true` line, with the
    // fully-formed `function.arguments` already parsed.
    let finishReason: AssistantMessage['finishReason']
    let modelName: string | undefined
    let lastContent = ''
    let promptEval: number | undefined
    let evalCount: number | undefined
    const completedToolCalls: ToolCall[] = []
    let toolCallCounter = 0

    try {
      for await (const line of parseNdjsonLines(response.body)) {
        const parsed = parseResponseJson(line, OllamaChatResponseSchema)
        if (parsed.model) modelName = parsed.model
        // Content delta
        if (parsed.message.content) {
          lastContent += parsed.message.content
          yield { type: 'content_delta', delta: parsed.message.content }
        }
        // Tool calls (only present on final `done:true` chunk)
        if (parsed.message.tool_calls) {
          for (const tc of parsed.message.tool_calls) {
            const fn = tc.function
            if (!fn) continue
            const toolCall: ToolCall = {
              id: `ollama_call_${toolCallCounter++}_${Date.now()}`,
              name: fn.name,
              arguments: fn.arguments,
            }
            completedToolCalls.push(toolCall)
            yield { type: 'tool_call_complete', toolCall }
          }
        }
        // Usage may arrive on intermediate chunks (newer Ollama) or only
        // on the final one. Keep the latest values.
        if (parsed.prompt_eval_count !== undefined) promptEval = parsed.prompt_eval_count
        if (parsed.eval_count !== undefined) evalCount = parsed.eval_count
        if (parsed.done_reason !== undefined) {
          finishReason = mapDoneReason(parsed.done_reason, completedToolCalls.length > 0)
        }
        if (parsed.done === true) {
          // Ollama stops sending once `done:true` arrives. We can break.
          break
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err
      if (err instanceof ResponseShapeError) {
        throw new ProviderError(err.message, { providerId: this.id, retryable: false, cause: err })
      }
      throw err
    }

    yield {
      type: 'message_complete',
      message: {
        role: 'assistant',
        content: lastContent.length > 0 ? lastContent : undefined,
        toolCalls: completedToolCalls,
        ...(modelName ? { model: modelName } : { model: request.model }),
        ...(finishReason ? { finishReason } : {}),
        ...(mapUsage(promptEval, evalCount) ? { usage: mapUsage(promptEval, evalCount)! } : {}),
      },
    }
  }

  public override async embed(
    request: EmbedRequest,
    options?: StreamOptions,
  ): Promise<EmbedResponse> {
    if (request.input.length === 0) {
      throw new ProviderError('EmbedRequest.input must contain at least one string', {
        providerId: this.id,
        retryable: false,
      })
    }
    if (this.useLegacyEmbeddings) {
      // Legacy endpoint takes a single `prompt: string` per call. Issue
      // one request per input and concatenate the vectors.
      const vectors: number[][] = []
      let totalInputTokens = 0
      for (const text of request.input) {
        const body = { model: request.model || this.defaultModel, prompt: text }
        const response = await this.performFetch('/api/embeddings', body, options)
        const rawText = await response.text()
        if (!response.ok) {
          throw this.makeHttpError(response.status, rawText)
        }
        const parsed = parseResponseJson(rawText, OllamaEmbedResponseSchema)
        if (!parsed.embedding) {
          throw new ResponseShapeError(
            [
              {
                path: 'embedding',
                message: 'Ollama /api/embeddings response missing `embedding` field',
              },
            ],
            rawText,
          )
        }
        vectors.push(parsed.embedding)
        // Legacy endpoint doesn't report input token usage; we count
        // characters as a rough proxy for client telemetry.
        totalInputTokens += text.length
      }
      return {
        vectors,
        model: request.model,
        usage: { inputTokens: totalInputTokens },
      }
    }
    // Newer `/api/embed` endpoint takes `input: string[]` in a single call.
    const body = { model: request.model || this.defaultModel, input: [...request.input] }
    const response = await this.performFetch('/api/embed', body, options)
    const rawText = await response.text()
    if (!response.ok) {
      throw this.makeHttpError(response.status, rawText)
    }
    const parsed = parseResponseJson(rawText, OllamaEmbedResponseSchema)
    if (!parsed.embeddings) {
      throw new ResponseShapeError(
        [{ path: 'embeddings', message: 'Ollama /api/embed response missing `embeddings` field' }],
        rawText,
      )
    }
    return {
      vectors: parsed.embeddings,
      model: parsed.model ?? request.model,
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private buildChatRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    if (!request.model || request.model.length === 0) {
      throw new ProviderError('ChatRequest.model is required', {
        providerId: this.id,
        retryable: false,
      })
    }
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: messagesToOllama(request.messages),
    }
    if (request.temperature !== undefined)
      body.options = { ...(body.options as object | undefined), temperature: request.temperature }
    if (request.maxTokens !== undefined) {
      const opts = (body.options as Record<string, unknown> | undefined) ?? {}
      opts.num_predict = request.maxTokens
      body.options = opts
    }
    if (request.topP !== undefined) {
      const opts = (body.options as Record<string, unknown> | undefined) ?? {}
      opts.top_p = request.topP
      body.options = opts
    }
    if (request.stop !== undefined && request.stop.length > 0) {
      const opts = (body.options as Record<string, unknown> | undefined) ?? {}
      opts.stop = request.stop.length === 1 ? request.stop[0] : [...request.stop]
      body.options = opts
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t: ToolDescriptor) => ollamaToolToWire(t))
    }
    if (stream) body.stream = true
    return body
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
        ...this.defaultHeaders,
        ...(options?.headers ?? {}),
      }
      if (this.apiKey.length > 0) {
        headers.authorization = `Bearer ${this.apiKey}`
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
        // When retry is enabled, surface non-2xx as a ProviderError here so
        // withRetry can re-issue the request. The caller's redundant
        // `!response.ok` check is harmless (never sees non-2xx) and
        // remains as the back-compat path when retry is disabled.
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
    const upstreamMessage = extractOllamaErrorMessage(body)
    return new ProviderError(upstreamMessage ?? `Ollama provider returned HTTP ${status}`, {
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

/** Convert a {@link ToolDescriptor} to the Ollama tool wire format. */
function ollamaToolToWire(t: ToolDescriptor): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputJsonSchema,
    },
  }
}

/** Pull a friendly `error` string out of an Ollama-style error body. */
function extractOllamaErrorMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error
      if (typeof err === 'string') return err
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
 * Convenience factory: build an {@link OllamaProvider} pointed at the
 * default local Ollama server.
 */
export function createOllamaProvider(opts: {
  readonly defaultModel: string
  readonly id?: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly defaultHeaders?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly useLegacyEmbeddings?: boolean
  readonly fetchImpl?: typeof fetch
}): OllamaProvider {
  return new OllamaProvider({
    id: opts.id,
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    defaultModel: opts.defaultModel,
    defaultHeaders: opts.defaultHeaders,
    timeoutMs: opts.timeoutMs,
    useLegacyEmbeddings: opts.useLegacyEmbeddings,
    fetchImpl: opts.fetchImpl,
  })
}
