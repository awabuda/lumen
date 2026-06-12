/** Tests for the Gemini provider. */

import { describe, expect, it } from 'vitest'
import { GeminiProvider, GeminiOptionsSchema } from '../src/gemini.js'

const fakeFetch = (responses: Record<string, { ok: boolean; status: number; body: string }>) =>
  (async (url: string) => {
    const entry = responses[url]
    if (!entry) {
      return {
        ok: false,
        status: 404,
        text: async () => 'not found',
      }
    }
    return {
      ok: entry.ok,
      status: entry.status,
      text: async () => entry.body,
    }
  }) as never

describe('GeminiOptionsSchema', () => {
  it('requires apiKey and defaultModel', () => {
    expect(GeminiOptionsSchema.safeParse({}).success).toBe(false)
    expect(
      GeminiOptionsSchema.safeParse({ apiKey: 'k', defaultModel: 'm' }).success,
    ).toBe(true)
  })

  it('defaults id to "gemini"', () => {
    const r = GeminiOptionsSchema.parse({ apiKey: 'k', defaultModel: 'm' })
    expect(r.id).toBe('gemini')
  })

  it('defaults baseUrl to the public Gemini endpoint', () => {
    const r = GeminiOptionsSchema.parse({ apiKey: 'k', defaultModel: 'm' })
    expect(r.baseUrl).toContain('generativelanguage.googleapis.com')
  })
})

describe('GeminiProvider', () => {
  it('exposes id and capabilities', () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      defaultModel: 'gemini-2.0-flash',
      fetchImpl: fakeFetch({}),
    })
    expect(provider.id).toBe('gemini')
    expect(provider.capabilities.toolUse).toBe(true)
    expect(provider.capabilities.embeddings).toBe(true)
    expect(provider.capabilities.vision).toBe(true)
  })

  it('sends the API key as a query param', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = (async (url: string) => {
      calls.push(url)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }],
          }),
      }
    }) as never
    const provider = new GeminiProvider({
      apiKey: 'test-key',
      defaultModel: 'gemini-2.0-flash',
      fetchImpl,
    })
    const res = await provider.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.message.content).toBe('hi')
    expect(calls[0]).toContain('key=test-key')
    expect(calls[0]).toContain('models/gemini-2.0-flash:generateContent')
  })

  it('parses text response into AssistantMessage', async () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      defaultModel: 'gemini-2.0-flash',
      fetchImpl: fakeFetch({
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=k': {
          ok: true,
          status: 200,
          body: JSON.stringify({
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'hello world' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { totalTokenCount: 7 },
          }),
        },
      }),
    })
    const res = await provider.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(res.message.content).toBe('hello world')
    expect(res.message.finishReason).toBe('stop')
  })

  it('parses functionCall into toolCalls', async () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      defaultModel: 'gemini-2.0-flash',
      fetchImpl: fakeFetch({
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=k': {
          ok: true,
          status: 200,
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { functionCall: { name: 'read_file', args: { path: '/x' } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          }),
        },
      }),
    })
    const res = await provider.chat({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'read x' }],
    })
    expect(res.message.toolCalls).toHaveLength(1)
    expect(res.message.toolCalls[0]?.name).toBe('read_file')
    expect(res.message.toolCalls[0]?.arguments).toEqual({ path: '/x' })
    expect(res.message.finishReason).toBe('tool_calls')
  })

  it('separates system instruction from contents', async () => {
    let captured = ''
    const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
      captured = init?.body as string
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }],
          }),
      }
    }) as never
    const provider = new GeminiProvider({
      apiKey: 'k',
      defaultModel: 'gemini-2.0-flash',
      fetchImpl,
    })
    await provider.chat({
      model: 'gemini-2.0-flash',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hi' },
      ],
    })
    const body = JSON.parse(captured) as {
      contents: Array<{ role: string }>
      systemInstruction: { parts: Array<{ text: string }> }
    }
    expect(body.systemInstruction.parts[0]?.text).toBe('be brief')
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0]?.role).toBe('user')
  })

  it('throws on HTTP 500 with retryable flag (Rule 7)', async () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      defaultModel: 'gemini-2.0-flash',
      fetchImpl: fakeFetch({
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=k': {
          ok: false,
          status: 500,
          body: 'oops',
        },
      }),
    })
    await expect(
      provider.chat({
        model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toThrow(/500/)
  })

  it('embeds texts one at a time and returns vectors', async () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      defaultModel: 'gemini-2.0-flash',
      embedModel: 'text-embedding-004',
      fetchImpl: fakeFetch({
        'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=k': {
          ok: true,
          status: 200,
          body: JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }),
        },
      }),
    })
    const res = await provider.embed({
      model: 'text-embedding-004',
      input: ['hello', 'world'],
    })
    expect(res.vectors).toHaveLength(2)
    expect(res.vectors[0]).toEqual([0.1, 0.2, 0.3])
  })
})