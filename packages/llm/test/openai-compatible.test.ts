/**
 * Tests for the OpenAI-compatible provider.
 *
 * Strategy: inject a fake `fetch` that returns canned responses, so we
 * can exercise the full chat + tool-use code path without hitting the
 * network.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  OpenAICompatibleProvider,
  HttpStatusError,
  ResponseShapeError,
  isRetryableStatus,
} from '../src/index.js'
import type {
  AssistantMessage,
  ChatRequest,
  Message,
  StreamEvent,
  ToolCall,
  ToolMessage,
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
  opts: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {},
): OpenAICompatibleProvider =>
  new OpenAICompatibleProvider({
    id: 'test',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    fetchImpl,
    ...opts,
  })

const basicRequest = (messages: ReadonlyArray<Message>): ChatRequest => ({
  messages,
  model: 'test-model',
})

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('OpenAICompatibleProvider', () => {
  it('builds a correct request URL and headers', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'r1',
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    await provider.chat(basicRequest([{ role: 'user', content: 'hello' }]))
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://api.test.com/v1/chat/completions')
    const headers = init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer test-key')
    expect(headers['content-type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('test-model')
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('returns an AssistantMessage with content and usage', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'r1',
          model: 'test-model',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.chat(basicRequest([{ role: 'user', content: 'ping' }]))
    expect(response.message.content).toBe('pong')
    expect(response.message.toolCalls).toEqual([])
    expect(response.message.usage?.totalTokens).toBe(6)
    expect(response.message.finishReason).toBe('stop')
  })

  it('parses tool calls from the response', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'r1',
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"weather"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      },
    ])
    const provider = makeProvider(fetchImpl)
    const response = await provider.chat(
      basicRequest([{ role: 'user', content: 'what is the weather?' }]),
    )
    expect(response.message.content).toBeUndefined()
    expect(response.message.toolCalls.length).toBe(1)
    const tc: ToolCall = response.message.toolCalls[0]!
    expect(tc.name).toBe('lookup')
    expect(tc.arguments).toEqual({ q: 'weather' })
    expect(response.message.finishReason).toBe('tool_calls')
  })

  it('converts a Lumen tool message into a single OpenAI role:tool message', async () => {
    let capturedBody = ''
    const fetchImpl: typeof fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = init?.body as string
      return new Response(
        JSON.stringify({
          choices: [
            { index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const provider = makeProvider(fetchImpl)
    const toolMsg: ToolMessage = {
      role: 'tool',
      results: [{ toolCallId: 'c1', content: 'sunny' }],
    }
    await provider.chat(
      basicRequest([
        { role: 'user', content: 'weather?' } as UserMessage,
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'lookup', arguments: {} }],
        } as AssistantMessage,
        toolMsg,
      ]),
    )
    const body = JSON.parse(capturedBody)
    // Expect 3 messages: user, assistant-with-tool_calls, tool-with-tool_call_id
    expect(body.messages.length).toBe(3)
    expect(body.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'sunny',
    })
  })

  it('throws an error when the HTTP status is non-2xx and marks 5xx/429 retryable', async () => {
    const fetchImpl = makeFetch([{ status: 503, body: { error: 'unavailable' } }])
    const provider = makeProvider(fetchImpl)
    // Provider wraps HttpStatusError inside ProviderError
    let caught: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'x' }]))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeDefined()
    // Walk the cause chain to find the HttpStatusError
    let current: unknown = caught
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
    expect((caught as { retryable: boolean }).retryable).toBe(true)
  })

  it('throws ResponseShapeError when the body does not match the schema', async () => {
    const fetchImpl = makeFetch([{ body: { totally: 'wrong' } }])
    const provider = makeProvider(fetchImpl)
    await expect(
      provider.chat(basicRequest([{ role: 'user', content: 'x' }])),
    ).rejects.toBeInstanceOf(ResponseShapeError)
  })

  it('streams chunks into StreamEvents', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n')
    const fetchImpl = makeFetch([{ sse }])
    const provider = makeProvider(fetchImpl)
    const events: StreamEvent[] = []
    for await (const ev of provider.stream(basicRequest([{ role: 'user', content: 'hi' }]))) {
      events.push(ev)
    }
    // Expect: message_start, 2x content_delta ("Hel", "lo"), message_complete
    expect(events[0]?.type).toBe('message_start')
    const deltas = events.filter((e) => e.type === 'content_delta') as Array<{
      type: 'content_delta'
      delta: string
    }>
    expect(deltas.map((d) => d.delta).join('')).toBe('Hello')
    expect(events.at(-1)?.type).toBe('message_complete')
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

  it('embed() throws when capabilities.embeddings is false (default)', async () => {
    const provider = makeProvider(makeFetch([]))
    await expect(provider.embed({ input: ['x'], model: 'test-model' })).rejects.toThrow(
      /embeddings/,
    )
  })

  it('throws if baseUrl is missing', () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          baseUrl: '',
          apiKey: 'x',
          defaultModel: 'y',
        }),
    ).toThrow(/baseUrl.*required/)
  })
})
