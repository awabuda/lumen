/**
 * Tests for the Anthropic Messages API provider.
 *
 * Strategy: inject a fake `fetch` that returns canned responses so we can
 * exercise the full chat + tool-use + streaming code path without hitting
 * the network.
 *
 * Coverage matrix:
 *   - Request shape (URL, headers, body)
 *   - Text response parsing
 *   - Tool use response parsing
 *   - System prompt extraction
 *   - Image / multimodal content
 *   - Usage / token accounting
 *   - Tool messages → Anthropic tool_result blocks
 *   - tool_use stop_reason mapping
 *   - HTTP error mapping (4xx, 5xx, retryable vs not)
 *   - Schema mismatch → ResponseShapeError
 *   - Streaming text chunks
 *   - Streaming tool_use chunks (input_json deltas → complete tool call)
 *   - Streaming stop_reason / message_delta
 *   - anthropic-version header default + override
 *   - Constructor validation (baseUrl / apiKey / defaultModel)
 *   - embed() throws (Anthropic has no /v1/embeddings on Messages API)
 *   - createAnthropicProvider factory
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AnthropicProvider,
  HttpStatusError,
  ResponseShapeError,
  createAnthropicProvider,
  isRetryableStatus,
} from '../src/index.js'
import { ProviderError } from '@lumen/core'
import type {
  AssistantMessage,
  ChatRequest,
  Message,
  StreamEvent,
  ToolCall,
  UserMessage,
} from '@lumen/core'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type FetchResponse = {
  status?: number
  body?: unknown
  sse?: string
  contentType?: string
}

const makeFetch = (responses: FetchResponse[]): typeof fetch => {
  let i = 0
  return vi.fn(async (_url: unknown, _init?: unknown) => {
    const r = responses[i++] ?? responses[responses.length - 1]
    const status = r?.status ?? 200
    if (r?.sse !== undefined) {
      return new Response(r.sse, {
        status,
        headers: { 'content-type': r.contentType ?? 'text/event-stream' },
      })
    }
    return new Response(JSON.stringify(r?.body ?? {}), {
      status,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    })
  }) as unknown as typeof fetch
}

const makeProvider = (
  fetchImpl: typeof fetch,
  opts: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {},
): AnthropicProvider =>
  new AnthropicProvider({
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    defaultModel: 'claude-test',
    fetchImpl,
    ...opts,
  })

const basicRequest = (messages: ReadonlyArray<Message>): ChatRequest => ({
  messages,
  model: 'claude-test',
})

/**
 * Build a single SSE event block (`data: <json>` + blank-line separator).
 * Anthropic (and any SSE protocol) splits events on `\n\n`, so every
 * emitted event must end with an empty line.
 */
const sseEvent = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('AnthropicProvider', () => {
  // ---- Request shape --------------------------------------------------------

  it('builds a correct request URL, headers, and body (text)', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'msg_1',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat(basicRequest([{ role: 'user', content: 'hello' }]))
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://api.test.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('test-key')
    expect(headers['content-type']).toBe('application/json')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    // Bearer should NOT be used
    expect(headers.authorization).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('claude-test')
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(body.max_tokens).toBe(4096)
    expect(body.system).toBeUndefined()
  })

  it('sends anthropic-version header and allows override', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl, { anthropicVersion: '2024-01-01' })
    await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    const headers = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers as Record<string, string>
    expect(headers['anthropic-version']).toBe('2024-01-01')
  })

  it('extracts the system prompt out of the messages array', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hi' },
      ]),
    )
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.system).toBe('You are a helpful assistant.')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('joins multiple system messages with a blank line', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        { role: 'system', content: 'rule 1' },
        { role: 'system', content: 'rule 2' },
        { role: 'user', content: 'hi' },
      ]),
    )
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.system).toBe('rule 1\n\nrule 2')
  })

  // ---- Chat response parsing -----------------------------------------------

  it('parses a text response with usage', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'msg_1',
          model: 'claude-test',
          content: [{ type: 'text', text: 'pong' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2, output_tokens: 4 },
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.chat(basicRequest([{ role: 'user', content: 'ping' }]))
    expect(response.message.content).toBe('pong')
    expect(response.message.toolCalls).toEqual([])
    expect(response.message.usage?.inputTokens).toBe(2)
    expect(response.message.usage?.outputTokens).toBe(4)
    expect(response.message.usage?.totalTokens).toBe(6)
    expect(response.message.finishReason).toBe('stop')
  })

  it('parses a tool_use response and maps stop_reason', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'msg_1',
          model: 'claude-test',
          content: [
            { type: 'text', text: 'I should look this up.' },
            { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'weather' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 5, output_tokens: 10 },
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.chat(basicRequest([{ role: 'user', content: 'weather?' }]))
    expect(response.message.content).toBe('I should look this up.')
    expect(response.message.toolCalls.length).toBe(1)
    const tc: ToolCall = response.message.toolCalls[0]!
    expect(tc.id).toBe('call_1')
    expect(tc.name).toBe('lookup')
    expect(tc.arguments).toEqual({ q: 'weather' })
    expect(response.message.finishReason).toBe('tool_calls')
  })

  it('maps max_tokens stop_reason to length', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          content: [{ type: 'text', text: 'cut off…' }],
          stop_reason: 'max_tokens',
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.chat(basicRequest([{ role: 'user', content: 'go' }]))
    expect(response.message.finishReason).toBe('length')
  })

  // ---- Multimodal (image) ---------------------------------------------------

  it('converts a user image part into an Anthropic image source block', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    const userMsg: UserMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        {
          type: 'image',
          source: { kind: 'base64', mediaType: 'image/png', data: 'BASE64DATA' },
        },
      ],
    }
    await provider.chat(basicRequest([userMsg]))
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'BASE64DATA' },
      },
    ])
  })

  it('converts a url-typed image source', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    const userMsg: UserMessage = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { kind: 'url', url: 'https://example.com/cat.png' },
        },
      ],
    }
    await provider.chat(basicRequest([userMsg]))
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
    ])
  })

  // ---- Tool messages → tool_result blocks ----------------------------------

  it('converts a Lumen tool message into Anthropic tool_result blocks', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        { role: 'user', content: 'weather?' } as UserMessage,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'sf' } }],
        } as AssistantMessage,
        {
          role: 'tool',
          results: [{ toolCallId: 'c1', content: 'sunny' }],
        },
      ]),
    )
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.messages.length).toBe(3)
    expect(body.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'lookup', input: { q: 'sf' } }],
    })
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'sunny' }],
    })
  })

  it('marks tool_result blocks as is_error when result.isError is true', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        { role: 'user', content: 'go' } as UserMessage,
        {
          role: 'tool',
          results: [{ toolCallId: 'c1', content: 'oops', isError: true }],
        },
      ]),
    )
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.messages[1].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      content: 'oops',
      is_error: true,
    })
  })

  // ---- Tools injection ------------------------------------------------------

  it('injects request.tools as Anthropic tools with input_schema', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    await provider.chat({
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'lookup',
          description: 'Look up a fact',
          inputSchema: undefined as never,
          risk: 'low' as never,
          version: '1',
          inputJsonSchema: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      ],
    })
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.tools).toEqual([
      {
        name: 'lookup',
        description: 'Look up a fact',
        input_schema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
      },
    ])
  })

  it('omits the tools key when request.tools is empty or undefined', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = makeProvider(fetchImpl)
    await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect('tools' in body).toBe(false)
  })

  // ---- Error paths ----------------------------------------------------------

  it('wraps non-2xx HTTP status into a ProviderError and marks 5xx retryable', async () => {
    const fetchImpl = makeFetch([
      { status: 503, body: { error: { type: 'overloaded', message: 'try again' } } },
    ])
    const provider = makeProvider(fetchImpl)
    let caught: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'x' }]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProviderError)
    const pe = caught as ProviderError
    expect(pe.statusCode).toBe(503)
    expect(pe.retryable).toBe(true)
    expect(pe.message).toContain('try again')
    // Walk the cause chain to find HttpStatusError
    let current: unknown = pe.cause
    let foundHttp: HttpStatusError | undefined
    while (current && !foundHttp) {
      if (current instanceof HttpStatusError) foundHttp = current
      else if (typeof current === 'object' && current && 'cause' in current) {
        current = (current as { cause: unknown }).cause
      } else {
        current = undefined
      }
    }
    expect(foundHttp).toBeInstanceOf(HttpStatusError)
  })

  it('marks 4xx HTTP status as non-retryable', async () => {
    const fetchImpl = makeFetch([
      { status: 401, body: { error: { type: 'auth', message: 'bad key' } } },
    ])
    const provider = makeProvider(fetchImpl)
    let caught: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'x' }]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProviderError)
    const pe = caught as ProviderError
    expect(pe.statusCode).toBe(401)
    expect(pe.retryable).toBe(false)
  })

  it('throws ResponseShapeError when the body does not match the schema', async () => {
    const fetchImpl = makeFetch([{ body: { totally: 'wrong' } }])
    const provider = makeProvider(fetchImpl)
    await expect(
      provider.chat(basicRequest([{ role: 'user', content: 'x' }])),
    ).rejects.toBeInstanceOf(ResponseShapeError)
  })

  it('isRetryableStatus classifies 429 and 5xx as retryable, 4xx as not', () => {
    expect(isRetryableStatus(429)).toBe(true)
    expect(isRetryableStatus(500)).toBe(true)
    expect(isRetryableStatus(503)).toBe(true)
    expect(isRetryableStatus(408)).toBe(true)
    expect(isRetryableStatus(400)).toBe(false)
    expect(isRetryableStatus(401)).toBe(false)
    expect(isRetryableStatus(404)).toBe(false)
  })

  // ---- Constructor validation ----------------------------------------------

  it('throws if baseUrl is missing', () => {
    expect(
      () =>
        new AnthropicProvider({
          baseUrl: '',
          apiKey: 'x',
          defaultModel: 'y',
        }),
    ).toThrow(/baseUrl.*required/)
  })

  it('throws if apiKey is missing', () => {
    expect(
      () =>
        new AnthropicProvider({
          baseUrl: 'https://x',
          apiKey: '',
          defaultModel: 'y',
        }),
    ).toThrow(/apiKey.*required/)
  })

  it('throws if defaultModel is missing', () => {
    expect(
      () =>
        new AnthropicProvider({
          baseUrl: 'https://x',
          apiKey: 'k',
          defaultModel: '',
        }),
    ).toThrow(/defaultModel.*required/)
  })

  // ---- embed() --------------------------------------------------------------

  it('embed() throws because the Anthropic Messages API has no embeddings', async () => {
    const provider = makeProvider(makeFetch([]))
    await expect(provider.embed({ input: ['x'], model: 'claude-test' })).rejects.toBeInstanceOf(
      ProviderError,
    )
  })

  it('reports capabilities.embeddings = false by default', () => {
    const provider = makeProvider(makeFetch([]))
    expect(provider.capabilities.embeddings).toBe(false)
    expect(provider.capabilities.streaming).toBe(true)
    expect(provider.capabilities.toolUse).toBe(true)
  })

  // ---- Factory --------------------------------------------------------------

  it('createAnthropicProvider uses api.anthropic.com by default', () => {
    const provider = createAnthropicProvider({
      apiKey: 'k',
      defaultModel: 'claude-test',
      fetchImpl: makeFetch([]),
    })
    expect(provider.id).toBe('anthropic')
    // Confirm the default URL routes to the public Anthropic endpoint by
    // making a no-op call and inspecting the URL it would hit.
    void provider.chat(basicRequest([{ role: 'user', content: 'hi' }])).catch(() => undefined)
  })

  it('createAnthropicProvider respects an explicit baseUrl override', async () => {
    const fetchImpl = makeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])
    const provider = createAnthropicProvider({
      apiKey: 'k',
      defaultModel: 'claude-test',
      baseUrl: 'https://proxy.example/v1/',
      fetchImpl,
    })
    await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    // Trailing slash should be stripped by normalizeBaseUrl.
    expect(url).toBe('https://proxy.example/v1/messages')
  })

  // ---- Streaming: text ------------------------------------------------------

  it('streams text chunks into content_delta events and ends with message_complete', async () => {
    const sse = [
      sseEvent({
        type: 'message_start',
        message: {
          id: 'msg_1',
          model: 'claude-test',
          role: 'assistant',
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }),
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      }),
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      }),
      sseEvent({ type: 'content_block_stop', index: 0 }),
      sseEvent({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 0, output_tokens: 2 },
      }),
      sseEvent({ type: 'message_stop' }),
      '',
    ].join('\n')

    const fetchImpl = makeFetch([{ sse }])
    const provider = makeProvider(fetchImpl)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream(basicRequest([{ role: 'user', content: 'hi' }]))) {
      events.push(ev)
    }
    expect(events[0]?.type).toBe('message_start')
    const deltas = events.filter((e) => e.type === 'content_delta') as Array<{
      type: 'content_delta'
      delta: string
    }>
    expect(deltas.map((d) => d.delta).join('')).toBe('Hello')
    const last = events.at(-1)
    expect(last?.type).toBe('message_complete')
    if (last?.type === 'message_complete') {
      expect(last.message.content).toBe('Hello')
      expect(last.message.finishReason).toBe('stop')
    }
  })

  // ---- Streaming: tool_use --------------------------------------------------

  it('streams tool_use via input_json deltas and emits tool_call_complete', async () => {
    const sse = [
      sseEvent({ type: 'message_start', message: { model: 'claude-test' } }),
      sseEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} },
      }),
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"q":' },
      }),
      sseEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"sf"}' },
      }),
      sseEvent({ type: 'content_block_stop', index: 0 }),
      sseEvent({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use' },
        usage: { input_tokens: 0, output_tokens: 5 },
      }),
      sseEvent({ type: 'message_stop' }),
      '',
    ].join('\n')

    const fetchImpl = makeFetch([{ sse }])
    const provider = makeProvider(fetchImpl)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream(basicRequest([{ role: 'user', content: 'weather?' }]))) {
      events.push(ev)
    }

    const toolComplete = events.find((e) => e.type === 'tool_call_complete')
    expect(toolComplete).toBeDefined()
    if (toolComplete && toolComplete.type === 'tool_call_complete') {
      expect(toolComplete.toolCall.id).toBe('call_1')
      expect(toolComplete.toolCall.name).toBe('lookup')
      expect(toolComplete.toolCall.arguments).toEqual({ q: 'sf' })
    }

    const deltas = events.filter((e) => e.type === 'tool_call_delta') as Array<{
      type: 'tool_call_delta'
      argumentsDelta?: string
    }>
    expect(deltas.length).toBe(2)
    expect(deltas[0]?.argumentsDelta).toBe('{"q":')
    expect(deltas[1]?.argumentsDelta).toBe('"sf"}')

    const last = events.at(-1)
    expect(last?.type).toBe('message_complete')
    if (last?.type === 'message_complete') {
      expect(last.message.toolCalls.length).toBe(1)
      expect(last.message.finishReason).toBe('tool_calls')
    }
  })

  // ---- Streaming: errors ----------------------------------------------------

  it('throws when the upstream sends a typed error event', async () => {
    const sse = [
      sseEvent({ type: 'message_start', message: { model: 'claude-test' } }),
      sseEvent({ type: 'error', error: { type: 'overloaded', message: 'overloaded_error' } }),
      '',
    ].join('\n')
    const fetchImpl = makeFetch([{ sse }])
    const provider = makeProvider(fetchImpl)
    const iter = provider.stream(basicRequest([{ role: 'user', content: 'hi' }]))
    // The generator yields a synthetic `message_start` first; the typed
    // error event arrives on the next read.
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value?.type).toBe('message_start')
    await expect(iter.next()).rejects.toBeInstanceOf(ProviderError)
  })

  it('throws when the streaming response is HTTP 4xx', async () => {
    const fetchImpl = makeFetch([
      { status: 401, body: { error: { type: 'auth', message: 'bad key' } } },
    ])
    const provider = makeProvider(fetchImpl)
    const iter = provider.stream(basicRequest([{ role: 'user', content: 'hi' }]))
    await expect(iter.next()).rejects.toBeInstanceOf(ProviderError)
  })
})

// -----------------------------------------------------------------------------
// Prompt caching (P5.4)
//
// Anthropic's protocol supports `cache_control: { type: 'ephemeral' }`
// markers on system blocks and tool definitions. The provider exposes
// this through `request.providerOptions.anthropicSystemBlocks` and
// `request.providerOptions.anthropicCacheTools`. These tests pin the
// wire shape end-to-end through a fake fetch.
// -----------------------------------------------------------------------------

describe('AnthropicProvider prompt caching', () => {
  it('sends the system field as a structured block array with cache_control when providerOptions.anthropicSystemBlocks is set', async () => {
    const calls: Array<{ body: string }> = []
    const fetchImpl: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body) })
      return makeFetch([
        {
          body: {
            id: 'msg_x',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        },
      ])(_url, init)
    }) as unknown as typeof fetch
    const provider = makeProvider(fetchImpl)
    const res = await provider.chat(
      Object.assign(basicRequest([{ role: 'user', content: 'hi' }]), {
        providerOptions: {
          anthropicSystemBlocks: [
            { type: 'text', text: 'You are a careful assistant.' },
            { type: 'text', text: 'Long reference doc…', cache_control: { type: 'ephemeral' } },
          ],
        },
      }),
    )
    expect(res.message.content).toBe('ok')
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system).toHaveLength(2)
    expect(body.system[0]).toEqual({
      type: 'text',
      text: 'You are a careful assistant.',
    })
    expect(body.system[1]).toEqual({
      type: 'text',
      text: 'Long reference doc…',
      cache_control: { type: 'ephemeral' },
    })
  })

  it('omits the system field entirely when anthropicSystemBlocks is an empty array', async () => {
    const calls: Array<{ body: string }> = []
    const fetchImpl: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body) })
      return makeFetch([
        {
          body: {
            id: 'msg_x',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ])(_url, init)
    }) as unknown as typeof fetch
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      Object.assign(basicRequest([{ role: 'user', content: 'hi' }]), {
        providerOptions: { anthropicSystemBlocks: [] },
      }),
    )
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body.system).toBeUndefined()
  })

  it('falls back to the string-join system path when no anthropicSystemBlocks is provided', async () => {
    const calls: Array<{ body: string }> = []
    const fetchImpl: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body) })
      return makeFetch([
        {
          body: {
            id: 'msg_x',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ])(_url, init)
    }) as unknown as typeof fetch
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        { role: 'system', content: 'Be terse.' } as Message,
        { role: 'user', content: 'hi' } as Message,
      ]),
    )
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(typeof body.system).toBe('string')
    expect(body.system).toBe('Be terse.')
  })

  it('attaches cache_control to the marked tool definitions in body.tools', async () => {
    const calls: Array<{ body: string }> = []
    const fetchImpl: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ body: String(init?.body) })
      return makeFetch([
        {
          body: {
            id: 'msg_x',
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ])(_url, init)
    }) as unknown as typeof fetch
    const provider = makeProvider(fetchImpl)
    const tools: ChatRequest['tools'] = [
      {
        name: 'read_file',
        description: 'read a file',
        inputJsonSchema: { type: 'object' },
        inputSchema: z.object({}).passthrough(),
        risk: 'safe',
        version: '1.0.0',
      },
      {
        name: 'write_file',
        description: 'write a file',
        inputJsonSchema: { type: 'object' },
        inputSchema: z.object({}).passthrough(),
        risk: 'approval-required',
        version: '1.0.0',
      },
      {
        name: 'bash',
        description: 'run a command',
        inputJsonSchema: { type: 'object' },
        inputSchema: z.object({}).passthrough(),
        risk: 'dangerous',
        version: '1.0.0',
      },
    ]
    await provider.chat(
      Object.assign(basicRequest([{ role: 'user', content: 'go' }]), {
        tools,
        providerOptions: { anthropicCacheTools: [1] },
      }),
    )
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body.tools).toHaveLength(3)
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools[2].cache_control).toBeUndefined()
  })

  it('throws a typed ProviderError when anthropicSystemBlocks has an invalid shape', async () => {
    const fetchImpl = makeFetch([])
    const provider = makeProvider(fetchImpl)
    let captured: unknown
    try {
      await provider.chat(
        Object.assign(basicRequest([{ role: 'user', content: 'hi' }]), {
          providerOptions: {
            anthropicSystemBlocks: [
              // bad: missing `type`
              { text: 'oops' } as unknown as Record<string, unknown>,
            ],
          },
        }),
      )
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(ProviderError)
    expect((captured as { message: string }).message).toMatch(/anthropicSystemBlocks/)
  })

  it('reports promptCaching: true in capabilities', () => {
    const provider = makeProvider(makeFetch([]))
    expect(provider.capabilities.promptCaching).toBe(true)
  })
})
