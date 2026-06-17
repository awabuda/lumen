/**
 * {@link BaseProvider} implementation for the Google Gemini API.
 *
 * Supports text, images, tool use, streaming, and embeddings
 * (via the text-embedding-004 model). Uses the public
 * `generativelanguage.googleapis.com` endpoint.
 *
 * Wire format notes (different from OpenAI/Anthropic/Ollama):
 *   - Messages: {role: "user"|"model", parts: [{text}|{inlineData}|{functionCall}|{functionResponse}]}
 *   - Tool definitions: tools: [{functionDeclarations: [{name, description, parameters}]}]
 *   - Response: {candidates: [{content: {parts: [...], role: "model"}, finishReason}]}
 *   - Stream: each SSE event is a single JSON object (not a delta array).
 *   - Auth: `?key=API_KEY` query param, not Authorization header.
 *   - Models: gemini-2.0-flash, gemini-2.0-pro, gemini-1.5-pro, etc.
 *
 * Why a separate file: the wire format diverges significantly
 * from OpenAI-compatible. Mixing it in would make that file
 * a god class.
 */

import { z } from 'zod'

import {
  type AssistantMessage,
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
  type Message,
  type ProviderCapabilities,
  ProviderError,
  type RetryConfig,
  type StreamEvent,
  type StreamOptions,
  type ToolMessage,
  type UserMessage,
  ValidationError,
  withRetry,
} from '@lumen/core'

import { HttpStatusError, isRetryableStatus, parseResponseJson } from './errors.js'

// ---------------------------------------------------------------------------
// Defaults + options
// ---------------------------------------------------------------------------

/** Default base URL for the public Gemini API. */
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com'

/** Default embedding model. */
const DEFAULT_EMBED_MODEL = 'text-embedding-004'

/** Zod schema for {@link GeminiOptions}. */
export const GeminiOptionsSchema = z.object({
  /** Stable identifier for this provider instance. */
  id: z.string().default('gemini'),
  /** API key. Required. */
  apiKey: z.string().min(1),
  /** Base URL. */
  baseUrl: z.string().url().default(DEFAULT_GEMINI_BASE_URL),
  /** Default model. */
  defaultModel: z.string().min(1),
  /** Per-request timeout in ms. */
  timeoutMs: z.number().int().positive().default(120_000),
  /** Embedding model. */
  embedModel: z.string().min(1).default(DEFAULT_EMBED_MODEL),
  /** Capability overrides. */
  capabilities: z
    .object({
      toolUse: z.boolean().optional(),
      streaming: z.boolean().optional(),
      embeddings: z.boolean().optional(),
      vision: z.boolean().optional(),
    })
    .partial()
    .optional(),
  /** Fetch implementation. */
  fetchImpl: z.custom<typeof fetch>().optional(),
  /**
   * Retry policy for transient HTTP failures (5xx, 408, 429).
   * Defaults to no retry.
   */
  retry: z
    .object({
      maxAttempts: z.number().int().positive().optional(),
      initialDelayMs: z.number().int().nonnegative().optional(),
      maxDelayMs: z.number().int().nonnegative().optional(),
      backoffFactor: z.number().positive().optional(),
      jitter: z.number().min(0).max(1).optional(),
    })
    .optional(),
})

/** Options for {@link GeminiProvider}. */
export type GeminiOptions = z.input<typeof GeminiOptionsSchema>

/** Default capabilities for Gemini providers. */
const defaultCapabilities = (): ProviderCapabilities => ({
  toolUse: true,
  streaming: true,
  embeddings: true,
  vision: true,
  reasoning: false,
  promptCaching: false,
  structuredOutput: false,
  maxContextTokens: 1_000_000,
})

// ---------------------------------------------------------------------------
// Gemini wire-format schemas
// ---------------------------------------------------------------------------

const GeminiPartTextSchema = z.object({ text: z.string() })

const GeminiInlineDataSchema = z.object({
  inlineData: z.object({
    mimeType: z.string(),
    data: z.string(),
  }),
})

const GeminiFunctionCallSchema = z.object({
  functionCall: z.object({
    name: z.string(),
    args: z.record(z.unknown()).optional(),
  }),
})

const GeminiFunctionResponseSchema = z.object({
  functionResponse: z.object({
    name: z.string(),
    response: z.record(z.unknown()).optional(),
  }),
})

const GeminiPartSchema = z.union([
  GeminiPartTextSchema,
  GeminiInlineDataSchema,
  GeminiFunctionCallSchema,
  GeminiFunctionResponseSchema,
])

const GeminiContentSchema = z.object({
  role: z.enum(['user', 'model']),
  parts: z.array(GeminiPartSchema).min(1),
})

const GeminiToolDeclarationSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
})

const GeminiToolSchema = z.object({
  functionDeclarations: z.array(GeminiToolDeclarationSchema).min(1),
})

const GeminiSystemInstructionSchema = z.object({
  parts: z.array(GeminiPartTextSchema).min(1),
})

const GeminiGenerateRequestSchema = z.object({
  contents: z.array(GeminiContentSchema).min(1),
  systemInstruction: GeminiSystemInstructionSchema.optional(),
  tools: z.array(GeminiToolSchema).optional(),
  generationConfig: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      topP: z.number().min(0).max(1).optional(),
      stopSequences: z.array(z.string()).optional(),
    })
    .optional(),
})

const GeminiCandidateSchema = z.object({
  content: GeminiContentSchema.optional(),
  finishReason: z.enum(['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER']).optional(),
})

const GeminiUsageSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional(),
})

const GeminiGenerateResponseSchema = z.object({
  candidates: z.array(GeminiCandidateSchema).min(1),
  usageMetadata: GeminiUsageSchema.optional(),
})

const GeminiEmbedResponseSchema = z.object({
  embedding: z.object({ values: z.array(z.number()) }),
})

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Gemini provider. Uses query-param auth (`?key=...`) and a
 * parts-based message format.
 */
export class GeminiProvider extends BaseProvider {
  public override readonly id: string
  public override readonly capabilities: ProviderCapabilities

  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly defaultModel: string
  private readonly embedModel: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly retry: RetryConfig | undefined

  public constructor(options: GeminiOptions) {
    super()
    const parsed = GeminiOptionsSchema.parse(options)
    this.id = parsed.id
    this.apiKey = parsed.apiKey
    this.baseUrl = parsed.baseUrl.replace(/\/+$/, '')
    this.defaultModel = parsed.defaultModel
    this.embedModel = parsed.embedModel
    this.timeoutMs = parsed.timeoutMs
    this.retry = parsed.retry
    this.fetchImpl =
      parsed.fetchImpl ??
      (typeof globalThis.fetch === 'function'
        ? (globalThis.fetch.bind(globalThis) as typeof fetch)
        : (() => {
            throw new ValidationError(
              'GeminiProvider: no fetch implementation available. Pass `fetchImpl` or run on Node 20+.',
              { field: 'fetchImpl' },
            )
          })())
    this.capabilities = { ...defaultCapabilities(), ...(parsed.capabilities ?? {}) }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  public override async chat(request: ChatRequest, options?: StreamOptions): Promise<ChatResponse> {
    this.validateRequest(request)
    const start = Date.now()
    const body = this.buildRequestBody(request)
    const url = this.chatUrl(request.model)
    const response = await this.performFetch(url, body, false, options)
    const text = await response.text()
    if (!response.ok) {
      throw this.makeHttpError(response.status, text)
    }
    const parsed = parseResponseJson(text, GeminiGenerateResponseSchema)
    return this.responseToChatResponse(parsed, start)
  }

  public override async *stream(
    request: ChatRequest,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    this.validateRequest(request)
    const body = this.buildRequestBody(request)
    const url = this.chatUrl(request.model, /* stream */ true)
    const response = await this.performFetch(url, body, true, options)
    if (!response.ok) {
      const text = await response.text()
      throw this.makeHttpError(response.status, text)
    }
    const reader = response.body?.getReader()
    if (!reader) {
      throw new ProviderError('Gemini stream: no response body', {
        providerId: this.id,
        retryable: true,
      })
    }
    const decoder = new TextDecoder()
    let buffer = ''
    let lastMessage: AssistantMessage | undefined
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = GeminiGenerateResponseSchema.parse(JSON.parse(trimmed))
          const msg = this.candidateToMessage(parsed)
          if (msg) {
            lastMessage = msg
            yield { type: 'content_delta', delta: msg.content ?? '' }
            for (const tc of msg.toolCalls ?? []) {
              yield { type: 'tool_call_complete', toolCall: tc }
            }
          }
        } catch {
          // Skip malformed lines but keep streaming.
        }
      }
    }
    if (lastMessage) {
      yield { type: 'message_complete', message: lastMessage }
    }
  }

  public override async embed(
    request: EmbedRequest,
    options?: StreamOptions,
  ): Promise<EmbedResponse> {
    const model = request.model ?? this.embedModel
    const url = this.embedUrl(model)
    const vectors: number[][] = []
    for (const text of request.input) {
      const body = { content: { parts: [{ text }] } }
      const response = await this.performFetch(url, body, false, options)
      const respText = await response.text()
      if (!response.ok) {
        throw this.makeHttpError(response.status, respText)
      }
      const parsed = parseResponseJson(respText, GeminiEmbedResponseSchema)
      vectors.push(parsed.embedding.values)
    }
    return { vectors, model }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  protected override validateRequest(request: ChatRequest): void {
    if (!request.messages || request.messages.length === 0) {
      throw new ValidationError('GeminiProvider: messages array is empty', { field: 'messages' })
    }
  }

  private chatUrl(model: string, stream = false): string {
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    return `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:${action}?key=${encodeURIComponent(this.apiKey)}`
  }

  private embedUrl(model: string): string {
    return `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(this.apiKey)}`
  }

  private buildRequestBody(request: ChatRequest): z.infer<typeof GeminiGenerateRequestSchema> {
    const contents: z.infer<typeof GeminiContentSchema>[] = []
    let systemInstruction: z.infer<typeof GeminiSystemInstructionSchema> | undefined
    for (const m of request.messages) {
      const built = messageToGemini(m)
      if (built.system) {
        systemInstruction = { parts: [{ text: built.system }] }
        continue
      }
      if (built.parts && built.parts.length > 0 && built.role) {
        contents.push({ role: built.role, parts: built.parts })
      }
    }
    if (contents.length === 0) {
      throw new ProviderError('GeminiProvider: no user/model messages after filtering', {
        providerId: this.id,
        retryable: false,
      })
    }
    const body: z.infer<typeof GeminiGenerateRequestSchema> = { contents }
    if (systemInstruction) body.systemInstruction = systemInstruction
    if (request.tools && request.tools.length > 0) {
      body.tools = [{ functionDeclarations: request.tools.map(toToolDecl) }]
    }
    if (
      request.temperature !== undefined ||
      request.maxTokens !== undefined ||
      request.stop !== undefined
    ) {
      body.generationConfig = {}
      if (request.temperature !== undefined) body.generationConfig.temperature = request.temperature
      if (request.maxTokens !== undefined) body.generationConfig.maxOutputTokens = request.maxTokens
      if (request.stop !== undefined) body.generationConfig.stopSequences = [...request.stop]
    }
    return body
  }

  private responseToChatResponse(
    parsed: z.infer<typeof GeminiGenerateResponseSchema>,
    startedAt: number,
  ): ChatResponse {
    const candidate = parsed.candidates[0]
    if (!candidate) {
      throw new ProviderError('GeminiProvider: empty candidates array', {
        providerId: this.id,
        retryable: false,
      })
    }
    const message = this.candidateToMessage(parsed) ?? emptyAssistantMessage()
    const finishReason = mapFinishReason(candidate.finishReason, message)
    return {
      message: { ...message, finishReason },
      latencyMs: Date.now() - startedAt,
    }
  }

  private candidateToMessage(
    parsed: z.infer<typeof GeminiGenerateResponseSchema>,
  ): AssistantMessage | undefined {
    const candidate = parsed.candidates[0]
    if (!candidate) return undefined
    const textParts: string[] = []
    const toolCalls = []
    for (const part of candidate.content?.parts ?? []) {
      if ('text' in part) {
        textParts.push(part.text)
      } else if ('functionCall' in part) {
        const fc = part.functionCall
        toolCalls.push({
          id: `${fc.name}-${toolCalls.length}`,
          name: fc.name,
          arguments: fc.args ?? {},
        })
      }
    }
    return {
      role: 'assistant',
      content: textParts.join(''),
      toolCalls,
    }
  }

  private async performFetch(
    url: string,
    body: unknown,
    stream: boolean,
    options?: StreamOptions,
  ): Promise<Response> {
    const doFetch = async (): Promise<Response> => {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
      const baseSignal = options?.signal ?? new AbortController().signal
      if (stream) {
        ;(init.headers as Record<string, string>).accept = 'text/event-stream'
      }
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      init.signal = mergeSignals(baseSignal, controller.signal)
      try {
        const response = await this.fetchImpl(url, init)
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

  private makeHttpError(status: number, body: string): Error {
    if (isRetryableStatus(status)) {
      return new HttpStatusError(status, body, /* retryable */ true)
    }
    return new HttpStatusError(status, body, /* retryable */ false)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MessageBuildResult {
  /** System instruction text (for system messages). */
  readonly system?: string
  /** Gemini role. */
  readonly role?: 'user' | 'model'
  /** Gemini parts. */
  readonly parts?: z.infer<typeof GeminiPartSchema>[]
}

const messageToGemini = (m: Message): MessageBuildResult => {
  switch (m.role) {
    case 'system':
      return { system: m.content }
    case 'user':
      return { role: 'user', parts: userMessageToParts(m) }
    case 'assistant': {
      const parts = assistantMessageToParts(m)
      return parts.length > 0 ? { role: 'model', parts } : {}
    }
    case 'tool':
      return { role: 'user', parts: [toolMessageToPart(m)] }
  }
}

const userMessageToParts = (m: UserMessage): z.infer<typeof GeminiPartSchema>[] => {
  if (typeof m.content === 'string') {
    return [{ text: m.content }]
  }
  return m.content.map((c) => {
    if (c.type === 'text') {
      return { text: c.text }
    }
    if (c.source.kind === 'base64') {
      return {
        inlineData: {
          mimeType: c.source.mediaType,
          data: c.source.data,
        },
      }
    }
    // URL — Gemini doesn't fetch external URLs directly; we
    // fall back to a text marker. Real impl would download
    // and inline the bytes.
    return { text: `[image at ${c.source.url}]` }
  })
}

const assistantMessageToParts = (m: AssistantMessage): z.infer<typeof GeminiPartSchema>[] => {
  const parts: z.infer<typeof GeminiPartSchema>[] = []
  if (m.content) parts.push({ text: m.content })
  for (const tc of m.toolCalls ?? []) {
    parts.push({ functionCall: { name: tc.name, args: tc.arguments } })
  }
  return parts
}

const toolMessageToPart = (m: ToolMessage): z.infer<typeof GeminiPartSchema> => {
  const result = m.results[0]
  let payload: Record<string, unknown>
  if (!result) {
    payload = { result: '' }
  } else if (result.isError) {
    payload = { error: result.content ?? 'tool error' }
  } else if (result.data) {
    payload = result.data
  } else {
    payload = { result: result.content ?? '' }
  }
  return {
    functionResponse: {
      name: m.name ?? 'tool',
      response: payload,
    },
  }
}

const toToolDecl = (t: {
  readonly name: string
  readonly description?: string
  readonly inputJsonSchema?: unknown
}): z.infer<typeof GeminiToolDeclarationSchema> => {
  const out: z.infer<typeof GeminiToolDeclarationSchema> = { name: t.name }
  if (t.description) out.description = t.description
  if (t.inputJsonSchema) out.parameters = t.inputJsonSchema as Record<string, unknown>
  return out
}

const mapFinishReason = (
  raw: z.infer<typeof GeminiCandidateSchema>['finishReason'],
  msg: AssistantMessage,
): AssistantMessage['finishReason'] => {
  if ((msg.toolCalls?.length ?? 0) > 0) return 'tool_calls'
  if (raw === 'STOP') return 'stop'
  if (raw === 'MAX_TOKENS') return 'length'
  if (raw === 'SAFETY') return 'content_filter'
  return 'error'
}

const emptyAssistantMessage = (): AssistantMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: [],
})

const mergeSignals = (a: AbortSignal, b: AbortSignal): AbortSignal => {
  if (a.aborted || b.aborted) {
    return AbortSignal.abort()
  }
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return controller.signal
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Convenience factory for {@link GeminiProvider}. */
export const createGeminiProvider = (options: GeminiOptions): GeminiProvider =>
  new GeminiProvider(options)
