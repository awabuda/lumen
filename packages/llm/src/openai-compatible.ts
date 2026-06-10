/**
 * OpenAI-compatible provider.
 *
 * Implements {@link BaseProvider} against the OpenAI Chat Completions HTTP
 * protocol. Because DeepSeek, Moonshot (Kimi), Anthropic-via-gateway, Ollama,
 * vLLM, llama.cpp's server, MiniMax and most other modern backends expose
 * the same wire format (or a strict superset), one class covers them all.
 *
 * Wiring: the caller picks the endpoint via {@link OpenAICompatibleOptions.baseUrl}
 * and the auth via {@link OpenAICompatibleOptions.apiKey}; everything else
 * falls back to the OpenAI defaults. This deliberately **does not** hard-code
 * any specific provider's URL.
 *
 * Protocol notes:
 *   - POST {baseUrl}/chat/completions with `Authorization: Bearer <key>`.
 *   - Tool calls in requests use the `tools` array; tool calls in responses
 *     are nested under `choices[0].message.tool_calls`.
 *   - Streaming is server-sent events prefixed with `data: ` and terminated
 *     by `data: [DONE]`. We parse the chunks incrementally and feed the
 *     agent loop's {@link StreamEvent} union.
 *   - Stop reason mapping: `stop` → `'stop'`, `tool_calls` → `'tool_calls'`,
 *     `length` → `'length'`, `content_filter` → `'content_filter'`.
 *     Anything else (including missing) maps to `undefined` rather than
 *     fabricating a value.
 */

import { z } from 'zod'
import {
  BaseProvider,
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
  type ProviderCapabilities,
  type StreamEvent,
  type StreamOptions,
  type AssistantMessage,
  type ToolCall,
  type Message,
  type ContentPart,
  type ImagePart,
  type TextPart,
  type ToolResult,
  type UserMessage,
  type ToolDescriptor,
} from '@lumen/core'
import {
  HttpStatusError,
  ResponseShapeError,
  StreamParseError,
  isRetryableStatus,
  parseResponseJson,
} from './errors.js'

// ---------------------------------------------------------------------------
// Zod schemas for the OpenAI wire format
// ---------------------------------------------------------------------------
//
// The wire format is documented at https://platform.openai.com/docs/api-reference/chat.
// We keep these schemas tight enough to catch breaking changes but lenient on
// optional fields, because the various OpenAI-compatible vendors each implement
// a slightly different subset of the spec.

const OpenAIToolFunctionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
  strict: z.boolean().optional(),
})

const OpenAIToolSchema = z.object({
  type: z.literal('function'),
  function: OpenAIToolFunctionSchema,
})

const OpenAIToolCallFunctionSchema = z.object({
  name: z.string().min(1),
  arguments: z.string(),
})

const OpenAIToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: OpenAIToolCallFunctionSchema,
})

const OpenAIMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.null()]).optional(),
  name: z.string().optional(),
  // Tool calls only appear on assistant messages
  tool_calls: z.array(OpenAIToolCallSchema).optional(),
  // Tool results come back as `role: "tool"` with `tool_call_id`
  tool_call_id: z.string().optional(),
})

const OpenAIChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: OpenAIMessageSchema,
  finish_reason: z
    .union([z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']), z.string(), z.null()])
    .optional(),
})

const OpenAIUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
})

const OpenAIChatResponseSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z.array(OpenAIChoiceSchema).min(1),
  usage: OpenAIUsageSchema.optional(),
})

const OpenAIStreamToolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
})

const OpenAIStreamDeltaSchema = z.object({
  role: z.string().optional(),
  content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.array(OpenAIStreamToolCallDeltaSchema).optional(),
})

const OpenAIStreamChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  delta: OpenAIStreamDeltaSchema,
  finish_reason: z
    .union([z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']), z.string(), z.null()])
    .optional(),
})

const OpenAIStreamChunkSchema = z.object({
  id: z.string().optional(),
  object: z.string().optional(),
  created: z.number().optional(),
  model: z.string().optional(),
  choices: z.array(OpenAIStreamChoiceSchema).min(1),
})

// Public re-exports of the schemas so tests and downstream code can
// validate against the same shapes we use.
export const OpenAIRequestBodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(OpenAIMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  stream: z.boolean().optional(),
  tools: z.array(OpenAIToolSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.unknown())]).optional(),
})

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link OpenAICompatibleProvider}.
 *
 * `baseUrl` defaults to the public OpenAI endpoint but is **always
 * overridable** — this is the single point of configuration for swapping in
 * DeepSeek, Moonshot, Ollama, MiniMax, a local llama.cpp, or a corporate
 * gateway. `apiKey` may be empty for local servers that don't require
 * authentication.
 */
export interface OpenAICompatibleOptions {
  /** Stable identifier reported via `BaseProvider.id`. Defaults to `'openai'`. */
  readonly id?: string
  /** Base URL of the API, e.g. `https://api.openai.com/v1`. No trailing slash. */
  readonly baseUrl: string
  /** Bearer token (or empty for local servers). */
  readonly apiKey?: string
  /** Default model id, used when a request omits `model`. */
  readonly defaultModel: string
  /** Extra headers merged into every request (e.g. tracing ids). */
  readonly defaultHeaders?: Readonly<Record<string, string>>
  /** Per-request timeout in milliseconds. Defaults to 60s. */
  readonly timeoutMs?: number
  /** Capabilities override; lets callers opt into streaming/tool use they know the backend supports. */
  readonly capabilities?: Partial<ProviderCapabilities>
  /**
   * Inject a custom fetch implementation (used by tests). Defaults to the
   * global `fetch` available in Node 20+.
   */
  readonly fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize the user-supplied base URL: strip trailing slash, no path suffix. */
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
    promptCaching: false,
    structuredOutput: false,
    maxContextTokens: 128_000,
  }
}

/** Map an OpenAI tool-call argument JSON string into a plain object. */
function parseToolCallArguments(raw: string, toolCallId: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch (cause) {
    throw new ProviderError(
      `OpenAI-compatible provider returned invalid JSON in tool_call.arguments for ${toolCallId}`,
      { providerId: 'openai-compatible', retryable: false, cause },
    )
  }
}

/** Convert a Lumen `AssistantMessage` tool call to the OpenAI wire format. */
function toolCallToOpenAI(tc: ToolCall): {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
} {
  return {
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
    },
  }
}

/** Convert Lumen `Message`s to the OpenAI `messages` array. */
function messagesToOpenAI(messages: ReadonlyArray<Message>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const m of messages) {
    switch (m.role) {
      case 'system': {
        out.push({ role: 'system', content: m.content, ...(m.name ? { name: m.name } : {}) })
        break
      }
      case 'user': {
        out.push({ role: 'user', content: userContentToOpenAI(m), ...(m.name ? { name: m.name } : {}) })
        break
      }
      case 'assistant': {
        const msg: Record<string, unknown> = { role: 'assistant' }
        if (m.content !== undefined) msg.content = m.content
        if (m.toolCalls.length > 0) msg.tool_calls = m.toolCalls.map(toolCallToOpenAI)
        out.push(msg)
        break
      }
      case 'tool': {
        // OpenAI expects one message per tool result, not a single array
        for (const r of m.results) {
          out.push(toolResultToOpenAI(r))
        }
        break
      }
    }
  }
  return out
}

function userContentToOpenAI(m: UserMessage): string | Array<Record<string, unknown>> {
  if (typeof m.content === 'string') return m.content
  // Multimodal: map each part
  return m.content.map((p: ContentPart) => contentPartToOpenAI(p))
}

function contentPartToOpenAI(p: ContentPart): Record<string, unknown> {
  if (p.type === 'text') {
    const part: TextPart = p
    return { type: 'text', text: part.text }
  }
  // Image
  const img: ImagePart = p
  if (img.source.kind === 'url') {
    return { type: 'image_url', image_url: { url: img.source.url } }
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${img.source.mediaType};base64,${img.source.data}` },
  }
}

function toolResultToOpenAI(r: ToolResult): Record<string, unknown> {
  return {
    role: 'tool',
    tool_call_id: r.toolCallId,
    content: r.isError ? (r.content ?? `Error: ${r.toolCallId}`) : (r.content ?? ''),
  }
}

/** Map an OpenAI finish_reason to a Lumen `finishReason`. */
function mapFinishReason(reason: string | null | undefined): AssistantMessage['finishReason'] {
  if (reason === 'stop') return 'stop'
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_calls'
  if (reason === 'length') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return undefined
}

function mapUsage(usage: z.infer<typeof OpenAIUsageSchema> | undefined): AssistantMessage['usage'] {
  if (!usage) return undefined
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  }
}

/** Convert a validated OpenAI choice into a Lumen `AssistantMessage`. */
function choiceToAssistantMessage(
  choice: z.infer<typeof OpenAIChoiceSchema>,
  model: string | undefined,
): AssistantMessage {
  const msg = choice.message
  const content = typeof msg.content === 'string' ? msg.content : undefined
  const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: parseToolCallArguments(tc.function.arguments, tc.id),
  }))
  return {
    role: 'assistant',
    content,
    toolCalls,
    ...(model ? { model } : {}),
    ...(mapFinishReason(choice.finish_reason) ? { finishReason: mapFinishReason(choice.finish_reason)! } : {}),
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * {@link BaseProvider} implementation that talks to any OpenAI-compatible
 * HTTP backend.
 *
 * The provider does **not** carry any default URL — it must always be
 * constructed with a `baseUrl`. For convenience, the {@link createOpenAIProvider}
 * factory wires up the public OpenAI endpoint, and helpers like
 * {@link openAICompatibleFor} can build providers from
 * `ProviderConfig` entries.
 */
export class OpenAICompatibleProvider extends BaseProvider {
  public override readonly id: string
  public override readonly capabilities: ProviderCapabilities

  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly defaultModel: string
  private readonly defaultHeaders: Readonly<Record<string, string>>
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(options: OpenAICompatibleOptions) {
    super()
    if (!options.baseUrl || options.baseUrl.length === 0) {
      throw new Error('OpenAICompatibleProvider: `baseUrl` is required')
    }
    if (!options.defaultModel || options.defaultModel.length === 0) {
      throw new Error('OpenAICompatibleProvider: `defaultModel` is required')
    }
    this.id = options.id ?? 'openai-compatible'
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    this.apiKey = options.apiKey ?? ''
    this.defaultModel = options.defaultModel
    this.defaultHeaders = options.defaultHeaders ?? {}
    this.timeoutMs = options.timeoutMs ?? 60_000
    // Resolve the fetch implementation lazily: prefer the override, then
    // the global, then throw a helpful error if neither exists.
    this.fetchImpl =
      options.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as typeof fetch)
        : (() => {
            throw new Error(
              'OpenAICompatibleProvider: no fetch implementation available. Pass `fetchImpl` or run on Node 20+.',
            )
          })())
    this.capabilities = { ...defaultCapabilities(), ...(options.capabilities ?? {}) }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Send a chat request to `{baseUrl}/chat/completions` and return the
   * assistant's reply.
   *
   * @throws {@link ProviderError} for any non-2xx response or network failure.
   * @throws DOMException `AbortError` when `options.signal` fires.
   */
  public override async chat(request: ChatRequest, options?: StreamOptions): Promise<ChatResponse> {
    this.validateRequest(request)
    const start = Date.now()
    const body = this.buildRequestBody(request, /* stream */ false)
    const response = await this.performFetch('/chat/completions', body, options)
    const text = await response.text()
    if (!response.ok) {
      throw this.makeHttpError(response.status, text)
    }
    const parsed = parseResponseJson(text, OpenAIChatResponseSchema)
    const choice = parsed.choices[0]
    if (!choice) {
      throw new ProviderError('OpenAI-compatible provider returned 0 choices', {
        providerId: this.id,
        retryable: false,
      })
    }
    const message = choiceToAssistantMessage(choice, parsed.model ?? request.model)
    // Re-attach usage from the top-level `usage` field (choiceToAssistantMessage
    // does not have access to it).
    const messageWithUsage: AssistantMessage = {
      ...message,
      ...(parsed.usage ? { usage: mapUsage(parsed.usage)! } : {}),
    }
    return {
      message: messageWithUsage,
      raw: parsed,
      latencyMs: Date.now() - start,
    }
  }

  /**
   * Stream a chat response, yielding one or more {@link StreamEvent}s.
   *
   * Each `data: {...}` chunk is validated against {@link OpenAIStreamChunkSchema}
   * and translated into content deltas, tool-call deltas, and finally a
   * `message_complete` event. Tool calls are accumulated across chunks
   * (the OpenAI protocol streams them as partial JSON) and emitted complete.
   */
  public override async *stream(
    request: ChatRequest,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    this.validateRequest(request)
    const body = this.buildRequestBody(request, /* stream */ true)
    const response = await this.performFetch('/chat/completions', body, options)
    if (!response.ok) {
      const text = await response.text()
      throw this.makeHttpError(response.status, text)
    }
    if (!response.body) {
      throw new ProviderError('OpenAI-compatible provider returned empty body for streaming', {
        providerId: this.id,
        retryable: false,
      })
    }

    yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }

    // Accumulator for tool calls: the OpenAI streaming protocol sends them
    // as indexed partial chunks; we need to merge them before emitting
    // `tool_call_complete`.
    const toolAcc = new Map<number, { id: string; name: string; args: string }>()
    let finishReason: AssistantMessage['finishReason']
    let modelName: string | undefined
    let lastContent = ''

    try {
      for await (const chunk of parseSseChunks(response.body)) {
        const parsed = parseResponseJson(chunk, OpenAIStreamChunkSchema)
        if (parsed.model) modelName = parsed.model
        for (const choice of parsed.choices) {
          const delta = choice.delta
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            lastContent += delta.content
            yield { type: 'content_delta', delta: delta.content }
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (typeof tc.index !== 'number') continue
              const acc =
                toolAcc.get(tc.index) ??
                ({ id: '', name: '', args: '' } as { id: string; name: string; args: string })
              if (tc.id) acc.id = tc.id
              if (tc.function?.name) acc.name = tc.function.name
              if (tc.function?.arguments) acc.args += tc.function.arguments
              toolAcc.set(tc.index, acc)
              yield {
                type: 'tool_call_delta',
                id: tc.id,
                name: tc.function?.name,
                argumentsDelta: tc.function?.arguments,
              }
            }
          }
          if (choice.finish_reason) {
            finishReason = mapFinishReason(choice.finish_reason)
          }
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err
      if (err instanceof ResponseShapeError || err instanceof StreamParseError) {
        throw new ProviderError(err.message, { providerId: this.id, retryable: false, cause: err })
      }
      throw err
    }

    // Emit completed tool calls
    const completedToolCalls: ToolCall[] = []
    for (const [, acc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.id || !acc.name) {
        // Some servers omit id on intermediate chunks; bail rather than emit a
        // broken tool call.
        throw new ProviderError('OpenAI-compatible provider streamed a tool call without an id or name', {
          providerId: this.id,
          retryable: false,
        })
      }
      const toolCall: ToolCall = {
        id: acc.id,
        name: acc.name,
        arguments: parseToolCallArguments(acc.args, acc.id),
      }
      completedToolCalls.push(toolCall)
      yield { type: 'tool_call_complete', toolCall }
    }

    yield {
      type: 'message_complete',
      message: {
        role: 'assistant',
        content: lastContent.length > 0 ? lastContent : undefined,
        toolCalls: completedToolCalls,
        ...(modelName ? { model: modelName } : {}),
        ...(finishReason ? { finishReason } : {}),
      },
    }
  }

  /**
   * Embeddings are not part of the OpenAI-compatible "chat" surface that
   * this class targets. Override in a subclass or build a dedicated
   * `OpenAIEmbeddingProvider` if you need them.
   */
  public override async embed(_request: EmbedRequest, _options?: StreamOptions): Promise<EmbedResponse> {
    throw new ProviderError(`Provider ${this.id} does not implement embeddings via chat-completions`, {
      providerId: this.id,
      retryable: false,
    })
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Construct the JSON body for the chat completions endpoint. */
  private buildRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
    if (!request.model || request.model.length === 0) {
      throw new ProviderError('ChatRequest.model is required', {
        providerId: this.id,
        retryable: false,
      })
    }
    const body: Record<string, unknown> = {
      model: request.model || this.defaultModel,
      messages: messagesToOpenAI(request.messages),
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.topP !== undefined) body.top_p = request.topP
    if (request.stop !== undefined) body.stop = request.stop.length === 1 ? request.stop[0] : [...request.stop]
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((t: ToolDescriptor) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          ...(t.description ? { description: t.description } : {}),
          parameters: t.inputJsonSchema,
        },
      }))
    }
    if (stream) body.stream = true
    return body
  }

  /** Build a request, attach auth/headers, and execute the fetch. */
  private async performFetch(path: string, body: unknown, options?: StreamOptions): Promise<Response> {
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
    const timeout = setTimeout(() => controller.abort(new Error('request timeout')), this.timeoutMs)
    const signal = options?.signal
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeout)
        throw new DOMException('Aborted', 'AbortError')
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
    }
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Convert a non-2xx HTTP response into a typed `ProviderError`. */
  private makeHttpError(status: number, body: string): ProviderError {
    const retryable = isRetryableStatus(status)
    // Try to surface the upstream error message verbatim, falling back to the
    // raw body.
    const upstreamMessage = extractUpstreamMessage(body)
    return new ProviderError(
      upstreamMessage ?? `OpenAI-compatible provider returned HTTP ${status}`,
      { providerId: this.id, statusCode: status, retryable, cause: new HttpStatusError(status, body, retryable) },
    )
  }
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

const SSE_DONE_MARKER = '[DONE]'

/**
 * Parse an SSE response body into individual `data:` payloads.
 *
 * The OpenAI chat-completions stream uses two relevant line shapes:
 *   - `data: {json}`  — one event per JSON object
 *   - `data: [DONE]`   — terminator; we stop iteration
 *
 * We strip comment lines (`: ...`), blank lines, and event-name lines. We
 * concatenate multi-line data values according to the SSE spec, although the
 * OpenAI providers we've seen never split a single event across lines.
 */
export async function* parseSseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE events are separated by a blank line. Split on \n\n and keep the
      // tail in the buffer in case the boundary straddles a chunk.
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const eventBlock = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        for (const payload of extractDataPayloads(eventBlock)) {
          if (payload === SSE_DONE_MARKER) return
          if (payload.length > 0) yield payload
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
    // Drain anything left in the buffer
    if (buffer.trim().length > 0) {
      for (const payload of extractDataPayloads(buffer)) {
        if (payload === SSE_DONE_MARKER) return
        if (payload.length > 0) yield payload
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Extract concatenated `data:` values from a single SSE event block. */
function extractDataPayloads(block: string): string[] {
  const lines = block.split(/\r?\n/)
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue // comment
    if (line.startsWith('data:')) {
      // `data: foo` and `data:foo` are both valid; strip the first space
      // after the colon only.
      dataLines.push(line.length > 5 && line[5] === ' ' ? line.slice(6) : line.slice(5))
    }
  }
  if (dataLines.length === 0) {
    throw new StreamParseError(block)
  }
  return [dataLines.join('\n')]
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

/** Pull a friendly `error.message` out of an OpenAI-style error body. */
function extractUpstreamMessage(body: string): string | undefined {
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
 * Convenience factory: build an {@link OpenAICompatibleProvider} pointed at
 * the public OpenAI endpoint.
 *
 * @param opts - All options except `baseUrl`, which is set to
 *   `https://api.openai.com/v1`.
 */
export function createOpenAIProvider(opts: {
  readonly apiKey: string
  readonly defaultModel: string
  readonly id?: string
  readonly defaultHeaders?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: opts.id ?? 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: opts.apiKey,
    defaultModel: opts.defaultModel,
    defaultHeaders: opts.defaultHeaders,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  })
}
