import { ProviderError, RetryExhaustedError } from '@lumen/core'
import type { ChatRequest, Message, StreamEvent, ToolCall, UserMessage } from '@lumen/core'
/**
 * Tests for the Ollama provider.
 *
 * Strategy: inject a fake `fetch` that returns canned NDJSON / JSON
 * responses so we can exercise the full chat + tool-use + streaming +
 * embedding code path without hitting a real Ollama server.
 *
 * Coverage matrix:
 *   - Request shape (URL, headers, body, options folding)
 *   - Default baseUrl (no auth header for local Ollama)
 *   - Bearer header when an apiKey is supplied
 *   - Text response parsing + usage
 *   - Tool_use response parsing + done_reason mapping
 *   - Image / multimodal content → `images: string[]` field
 *   - Tool messages → `role:tool` messages
 *   - Tools injection
 *   - HTTP error mapping (4xx vs 5xx retryable)
 *   - Schema mismatch → ResponseShapeError
 *   - Streaming text chunks (NDJSON)
 *   - Streaming tool_call_complete (arrives on final `done:true` line)
 *   - Embed via /api/embed (newer batch endpoint)
 *   - Embed via /api/embeddings (legacy single-prompt endpoint, useLegacyEmbeddings=true)
 *   - embed() throws on empty input
 *   - Constructor validation (defaultModel required, no apiKey required)
 *   - createOllamaProvider factory
 *   - parseNdjsonLines helper (called directly with a fake ReadableStream)
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OllamaProvider,
  ResponseShapeError,
  createOllamaProvider,
  parseNdjsonLines,
} from '../src/index.js'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type FetchResponse = {
  status?: number
  body?: unknown
  contentType?: string
}

const makeFetch = (responses: FetchResponse[]): typeof fetch => {
  let i = 0
  return vi.fn(async (_url: unknown, _init?: unknown) => {
    const r = responses[i++] ?? responses[responses.length - 1]
    const status = r?.status ?? 200
    return new Response(JSON.stringify(r?.body ?? {}), {
      status,
      headers: { 'content-type': r.contentType ?? 'application/json' },
    })
  }) as unknown as typeof fetch
}

const makeProvider = (
  fetchImpl: typeof fetch,
  opts: Partial<ConstructorParameters<typeof OllamaProvider>[0]> = {},
): OllamaProvider =>
  new OllamaProvider({
    defaultModel: 'llama3.1-test',
    fetchImpl,
    ...opts,
  })

const basicRequest = (messages: ReadonlyArray<Message>): ChatRequest => ({
  messages,
  model: 'llama3.1-test',
})

/**
 * Build a fake ReadableStream that yields the given string chunks one
 * by one (simulating Ollama's NDJSON streaming wire).
 */
function ndjsonStream(chunks: ReadonlyArray<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('OllamaProvider', () => {
  // ---- Request shape --------------------------------------------------------

  it('builds a correct request URL and body (text, no auth header)', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          model: 'llama3.1-test',
          done: true,
          done_reason: 'stop',
          message: { role: 'assistant', content: 'hi' },
          prompt_eval_count: 5,
          eval_count: 3,
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat(basicRequest([{ role: 'user', content: 'hello' }]))
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://127.0.0.1:11434/api/chat')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    // Local Ollama runs unauthenticated — no Authorization header.
    expect(headers.authorization).toBeUndefined()
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('llama3.1-test')
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    // Non-streaming requests omit `stream` (or set it to false).
    expect(body.stream).toBeFalsy()
  })

  it('attaches a Bearer header when apiKey is supplied', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'ok' }, done: true } },
    ])
    const provider = makeProvider(fetchImpl, { apiKey: 'proxy-token' })
    await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    const headers = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer proxy-token')
  })

  it('folds temperature / maxTokens / topP / stop into the `options` field', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'ok' }, done: true } },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat({
      model: 'llama3.1-test',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      maxTokens: 512,
      topP: 0.9,
      stop: ['\n\n', 'END'],
    })
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.options).toMatchObject({
      temperature: 0.7,
      num_predict: 512,
      top_p: 0.9,
      stop: ['\n\n', 'END'],
    })
  })

  // ---- Chat response parsing -----------------------------------------------

  it('parses a text response with usage', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          model: 'llama3.1-test',
          done: true,
          done_reason: 'stop',
          message: { role: 'assistant', content: 'pong' },
          prompt_eval_count: 2,
          eval_count: 4,
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

  it('parses a tool_use response and maps done_reason', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          model: 'llama3.1-test',
          done: true,
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: { name: 'lookup', arguments: { q: 'weather' } },
              },
            ],
          },
          prompt_eval_count: 5,
          eval_count: 10,
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.chat(basicRequest([{ role: 'user', content: 'weather?' }]))
    expect(response.message.toolCalls.length).toBe(1)
    const tc: ToolCall = response.message.toolCalls[0]!
    expect(tc.name).toBe('lookup')
    expect(tc.arguments).toEqual({ q: 'weather' })
    // Ollama always sends `done_reason: 'stop'`, but the presence of
    // tool calls tells the agent loop this is a tool turn — so the
    // Lumen-side finishReason is `tool_calls`.
    expect(response.message.finishReason).toBe('tool_calls')
  })

  // ---- Multimodal (image) ---------------------------------------------------

  it('converts a base64 image part into the message-level `images` field', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'ok' }, done: true } },
    ])
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
    expect(body.messages[0]).toEqual({
      role: 'user',
      content: 'what is this?',
      images: ['BASE64DATA'],
    })
  })

  it('strips a `data:...;base64,` prefix from image data', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'ok' }, done: true } },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                kind: 'base64',
                mediaType: 'image/png',
                data: 'data:image/png;base64,PAYLOAD',
              },
            },
          ],
        },
      ]),
    )
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.messages[0].images).toEqual(['PAYLOAD'])
  })

  // ---- Tool messages + tool injection --------------------------------------

  it('converts a Lumen tool message into Ollama role:tool messages', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'done' }, done: true } },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat(
      basicRequest([
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: { q: 'sf' } }],
        },
        {
          role: 'tool',
          results: [{ toolCallId: 'c1', content: 'sunny', isError: false }],
        },
      ]),
    )
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string,
    )
    expect(body.messages).toHaveLength(3)
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      tool_calls: [{ function: { name: 'lookup', arguments: { q: 'sf' } } }],
    })
    expect(body.messages[2]).toEqual({
      role: 'tool',
      content: 'sunny',
    })
  })

  it('injects request.tools as Ollama tools with function.parameters', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'ok' }, done: true } },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat({
      model: 'llama3.1-test',
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
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a fact',
          parameters: {
            type: 'object',
            properties: { q: { type: 'string' } },
            required: ['q'],
          },
        },
      },
    ])
  })

  // ---- Error paths ----------------------------------------------------------

  it('wraps non-2xx HTTP status into a ProviderError and marks 5xx retryable', async () => {
    const fetchImpl = makeFetch([{ status: 500, body: { error: 'server crash' } }])
    const provider = makeProvider(fetchImpl)
    let caught: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'x' }]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProviderError)
    const pe = caught as ProviderError
    expect(pe.statusCode).toBe(500)
    expect(pe.retryable).toBe(true)
    expect(pe.message).toContain('server crash')
  })

  it('marks 4xx HTTP status as non-retryable', async () => {
    const fetchImpl = makeFetch([{ status: 404, body: { error: 'model not found' } }])
    const provider = makeProvider(fetchImpl)
    let caught: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'x' }]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ProviderError)
    expect((caught as ProviderError).retryable).toBe(false)
  })

  it('throws ResponseShapeError when the body does not match the schema', async () => {
    const fetchImpl = makeFetch([{ body: { totally: 'wrong' } }])
    const provider = makeProvider(fetchImpl)
    await expect(
      provider.chat(basicRequest([{ role: 'user', content: 'x' }])),
    ).rejects.toBeInstanceOf(ResponseShapeError)
  })

  // ---- Constructor validation ----------------------------------------------

  it('throws if defaultModel is missing', () => {
    expect(
      () =>
        new OllamaProvider({
          defaultModel: '',
        }),
    ).toThrow(/defaultModel.*required/)
  })

  it('does not require an apiKey (Ollama is local by default)', () => {
    expect(
      () =>
        new OllamaProvider({
          defaultModel: 'llama3.1',
        }),
    ).not.toThrow()
  })

  it('reports default capabilities: embeddings=true, promptCaching=false', () => {
    const provider = makeProvider(makeFetch([]))
    expect(provider.capabilities.embeddings).toBe(true)
    expect(provider.capabilities.streaming).toBe(true)
    expect(provider.capabilities.toolUse).toBe(true)
    expect(provider.capabilities.promptCaching).toBe(false)
  })

  // ---- Streaming ------------------------------------------------------------

  it('streams NDJSON chunks into content_delta events and ends with message_complete', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          model: 'llama3.1-test',
          done: true,
          done_reason: 'stop',
          message: { role: 'assistant', content: 'Hello' },
          prompt_eval_count: 4,
          eval_count: 1,
        },
      },
    ])
    // Force the stream() path to use a fake NDJSON body via a stream response.
    // Since makeFetch always returns a plain JSON Response, we instead
    // exercise the streaming path by giving the provider a fetch that
    // returns a streaming response.
    const streamBody = ndjsonStream([
      `${JSON.stringify({ model: 'llama3.1-test', message: { role: 'assistant', content: 'Hel' } })}\n`,
      `${JSON.stringify({ model: 'llama3.1-test', message: { role: 'assistant', content: 'lo' } })}\n`,
      `${JSON.stringify({
        model: 'llama3.1-test',
        done: true,
        done_reason: 'stop',
        message: { role: 'assistant', content: '' },
        prompt_eval_count: 4,
        eval_count: 1,
      })}\n`,
    ])
    const streamingFetch: typeof fetch = vi.fn(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof fetch
    const provider = makeProvider(streamingFetch)
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
      expect(last.message.usage?.outputTokens).toBe(1)
    }
  })

  it('streams tool_call_complete when the final `done:true` line carries tool_calls', async () => {
    const streamBody = ndjsonStream([
      `${JSON.stringify({ model: 'llama3.1-test', message: { role: 'assistant', content: '' } })}\n`,
      `${JSON.stringify({
        model: 'llama3.1-test',
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'lookup', arguments: { q: 'sf' } } }],
        },
      })}\n`,
    ])
    const streamingFetch: typeof fetch = vi.fn(async () => {
      return new Response(streamBody, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof fetch
    const provider = makeProvider(streamingFetch)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream(basicRequest([{ role: 'user', content: 'weather?' }]))) {
      events.push(ev)
    }
    const toolComplete = events.find((e) => e.type === 'tool_call_complete')
    expect(toolComplete).toBeDefined()
    if (toolComplete && toolComplete.type === 'tool_call_complete') {
      expect(toolComplete.toolCall.name).toBe('lookup')
      expect(toolComplete.toolCall.arguments).toEqual({ q: 'sf' })
    }
    const last = events.at(-1)
    expect(last?.type).toBe('message_complete')
    if (last?.type === 'message_complete') {
      expect(last.message.toolCalls.length).toBe(1)
    }
  })

  it('throws when the streaming response is HTTP 4xx', async () => {
    const fetchImpl = makeFetch([{ status: 404, body: { error: 'model missing' } }])
    const provider = makeProvider(fetchImpl)
    const iter = provider.stream(basicRequest([{ role: 'user', content: 'hi' }]))
    await expect(iter.next()).rejects.toBeInstanceOf(ProviderError)
  })

  // ---- Embeddings -----------------------------------------------------------

  it('embed() hits /api/embed (newer batch endpoint) by default', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          model: 'nomic-embed-text',
          embeddings: [
            [0.1, 0.2, 0.3],
            [0.4, 0.5, 0.6],
          ],
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.embed({
      model: 'nomic-embed-text',
      input: ['hello', 'world'],
    })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('http://127.0.0.1:11434/api/embed')
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({ model: 'nomic-embed-text', input: ['hello', 'world'] })
    expect(response.vectors).toEqual([
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6],
    ])
    expect(response.model).toBe('nomic-embed-text')
  })

  it('embed() with useLegacyEmbeddings=true hits /api/embeddings once per input', async () => {
    const fetchImpl = makeFetch([
      { body: { embedding: [0.1, 0.2] } },
      { body: { embedding: [0.3, 0.4] } },
    ])
    const provider = makeProvider(fetchImpl, { useLegacyEmbeddings: true })
    const response = await provider.embed({
      model: 'nomic-embed-text',
      input: ['hello', 'world'],
    })
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, RequestInit]
    >
    expect(calls.length).toBe(2)
    expect(calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/embeddings')
    expect(JSON.parse(calls[0]?.[1].body as string)).toEqual({
      model: 'nomic-embed-text',
      prompt: 'hello',
    })
    expect(JSON.parse(calls[1]?.[1].body as string)).toEqual({
      model: 'nomic-embed-text',
      prompt: 'world',
    })
    expect(response.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
  })

  it('embed() throws when input is empty', async () => {
    const provider = makeProvider(makeFetch([]))
    await expect(provider.embed({ model: 'm', input: [] })).rejects.toBeInstanceOf(ProviderError)
  })

  it('embed() throws ResponseShapeError when the response has no `embeddings`', async () => {
    const fetchImpl = makeFetch([{ body: { model: 'm' } }])
    const provider = makeProvider(fetchImpl)
    await expect(provider.embed({ model: 'm', input: ['x'] })).rejects.toBeInstanceOf(
      ResponseShapeError,
    )
  })

  // ---- Factory --------------------------------------------------------------

  it('createOllamaProvider uses the local Ollama default baseUrl', () => {
    const provider = createOllamaProvider({
      defaultModel: 'llama3.1',
      fetchImpl: makeFetch([]),
    })
    expect(provider.id).toBe('ollama')
    expect(provider.capabilities.embeddings).toBe(true)
  })

  it('createOllamaProvider respects an explicit baseUrl override', async () => {
    const fetchImpl = makeFetch([
      { body: { message: { role: 'assistant', content: 'ok' }, done: true } },
    ])
    const provider = createOllamaProvider({
      defaultModel: 'llama3.1',
      baseUrl: 'http://192.168.1.5:11434/',
      fetchImpl,
    })
    await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    // Trailing slash should be stripped by normalizeBaseUrl.
    expect(url).toBe('http://192.168.1.5:11434/api/chat')
  })

  // ---- parseNdjsonLines helper ---------------------------------------------

  it('parseNdjsonLines splits a stream on newline boundaries and trims whitespace', async () => {
    const stream = ndjsonStream([
      `${JSON.stringify({ a: 1 })}\n`,
      `${JSON.stringify({ a: 2 })}\n`,
      JSON.stringify({ a: 3 }),
    ])
    const out: string[] = []
    for await (const line of parseNdjsonLines(stream)) {
      out.push(line)
    }
    expect(out).toEqual([
      JSON.stringify({ a: 1 }),
      JSON.stringify({ a: 2 }),
      JSON.stringify({ a: 3 }),
    ])
  })

  it('parseNdjsonLines handles a boundary that straddles two chunks', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // First chunk: complete line.
        controller.enqueue(encoder.encode('{"a":1}\n'))
        // Second chunk: half of the next line.
        controller.enqueue(encoder.encode('{"a":'))
        // Third chunk: rest of the line + a complete line.
        controller.enqueue(encoder.encode('2}\n{"a":3}\n'))
        controller.close()
      },
    })
    const out: string[] = []
    for await (const line of parseNdjsonLines(stream)) {
      out.push(line)
    }
    expect(out).toEqual(['{"a":1}', '{"a":2}', '{"a":3}'])
  })
})

// ---------------------------------------------------------------------------
// P9 — Retry boundary (transient HTTP failures)
// ---------------------------------------------------------------------------

describe('OllamaProvider retry boundary', () => {
  it('retries 5xx and returns the eventual 2xx response', async () => {
    const fetchImpl = makeFetch([
      { status: 503, body: { error: 'unavailable' } },
      {
        status: 200,
        body: {
          model: 'llama3.1-test',
          message: { role: 'assistant', content: 'hi back' },
          done: true,
        },
      },
    ])
    const provider = makeProvider(fetchImpl, { retry: { maxAttempts: 3, sleep: async () => {} } })
    const res = await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    expect(res.message.content).toBe('hi back')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry a 4xx (non-retryable) — single attempt', async () => {
    const fetchImpl = makeFetch([{ status: 400, body: { error: 'bad request' } }])
    const provider = makeProvider(fetchImpl, { retry: { maxAttempts: 3, sleep: async () => {} } })
    await expect(
      provider.chat(basicRequest([{ role: 'user', content: 'hi' }])),
    ).rejects.toBeInstanceOf(ProviderError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('exhausts maxAttempts on persistent 5xx and throws RetryExhaustedError wrapping ProviderError', async () => {
    const fetchImpl = makeFetch([{ status: 500, body: { error: 'kaboom' } }])
    const provider = makeProvider(fetchImpl, { retry: { maxAttempts: 3, sleep: async () => {} } })
    let caught: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RetryExhaustedError)
    expect((caught as RetryExhaustedError).cause).toBeInstanceOf(ProviderError)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry when no retry config is supplied (back-compat)', async () => {
    const fetchImpl = makeFetch([{ status: 503, body: { error: 'unavailable' } }])
    const provider = makeProvider(fetchImpl)
    await expect(
      provider.chat(basicRequest([{ role: 'user', content: 'hi' }])),
    ).rejects.toBeInstanceOf(ProviderError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// P6.2 fixtures — Ollama streaming edge cases + chat robustness
// ---------------------------------------------------------------------------

describe('OllamaProvider P6.2 fixtures', () => {
  // NDJSON stream body builder.
  const ndjsonStream = (lines: ReadonlyArray<string>): ReadableStream<Uint8Array> => {
    const enc = new TextEncoder()
    const data = lines.map((l) => (l.endsWith('\n') ? l : `${l}\n`)).join('')
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(data))
        controller.close()
      },
    })
  }

  it('streams multiple content deltas and coalesces them into a single message_complete', async () => {
    const lines = [
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: 'Hello' },
        done: false,
      }),
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: ' ' },
        done: false,
      }),
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: 'world' },
        done: false,
      }),
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        total_duration: 0,
      }),
    ]
    const fetchImpl = vi.fn(async () => {
      return new Response(ndjsonStream(lines), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof fetch
    const p = makeProvider(fetchImpl)

    const events: StreamEvent[] = []
    for await (const ev of p.stream(basicRequest([{ role: 'user', content: 'hi' }]))) {
      events.push(ev)
    }
    const deltas = events.filter(
      (e): e is { type: 'content_delta'; delta: string; id?: string } => e.type === 'content_delta',
    )
    expect(deltas.map((d) => d.delta).join('')).toBe('Hello world')
    const last = events[events.length - 1]
    expect(last?.type).toBe('message_complete')
  })

  it('throws ProviderError when the stream returns HTTP 5xx', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'model loading' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const p = makeProvider(fetchImpl)
    const iter = p.stream(basicRequest([{ role: 'user', content: 'hi' }]))
    await expect(iter.next()).rejects.toThrow()
  })

  it('skips NDJSON lines that lack a `message` field, only emitting deltas from content-carrying lines', async () => {
    const lines = [
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: 'one' },
        done: false,
      }),
      // A heartbeat / status line with no message — should be ignored.
      JSON.stringify({ model: 'llama3', message: { role: 'assistant', content: '' }, done: false }),
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: ' two' },
        done: false,
      }),
      JSON.stringify({
        model: 'llama3',
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
      }),
    ]
    const fetchImpl = vi.fn(async () => {
      return new Response(ndjsonStream(lines), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })
    }) as unknown as typeof fetch
    const p = makeProvider(fetchImpl)
    const events: StreamEvent[] = []
    for await (const ev of p.stream(basicRequest([{ role: 'user', content: 'x' }]))) {
      events.push(ev)
    }
    const deltas = events.filter(
      (e): e is { type: 'content_delta'; delta: string } => e.type === 'content_delta',
    )
    expect(deltas.map((d) => d.delta).join('')).toBe('one two')
  })

  it('chat() carries a multi-turn conversation (system + user + assistant) unchanged', async () => {
    const capturedBody: unknown[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      const body = JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}'))
      capturedBody.push(body)
      return new Response(
        JSON.stringify({
          id: 'cmpl-1',
          model: 'llama3',
          message: { role: 'assistant', content: 'pong' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const p = makeProvider(fetchImpl)
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'pong', toolCalls: [] },
      { role: 'user', content: 'ping again' },
    ]
    await p.chat({ messages, model: 'llama3' })
    expect(capturedBody.length).toBe(1)
    const body = capturedBody[0] as {
      messages: Array<{ role: string; content: string; toolCalls?: unknown[] }>
    }
    // Round-trip: every message's role + content survives, regardless
    // of any Lumen-internal-only fields (Ollama drops empty toolCalls).
    expect(body.messages.map((m) => ({ role: m.role, content: m.content }))).toEqual(
      messages.map((m) => ({ role: m.role, content: m.content })),
    )
  })

  it('chat() sends a system message even when only system content is present', async () => {
    const capturedBody: unknown[] = []
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      capturedBody.push(JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')))
      return new Response(
        JSON.stringify({
          id: 'cmpl-1',
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
          done_reason: 'stop',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const p = makeProvider(fetchImpl)
    await p.chat({
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'go' },
      ],
      model: 'llama3',
    })
    const body = capturedBody[0] as { messages: Array<{ role: string; content: string }> }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' })
  })
})
