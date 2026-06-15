/** Tests for the Mistral provider. */

/**
 * Mistral is OpenAI-compatible, so these tests are intentionally
 * structurally identical to the OpenAI tests. The Mistral-specific
 * surface (default base URL, default model, provider id) gets verified
 * here; the protocol parsing is covered by `openai-compatible.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  createMistralProvider,
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_MODEL,
  DEFAULT_MISTRAL_EMBED_MODEL,
  MISTRAL_PROVIDER_ID,
  MistralProvider,
  HttpStatusError,
} from '../src/index.js'
import { ProviderError } from '@lumen/core'
import type { ChatRequest, Message } from '@lumen/core'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type FetchResponse = {
  status?: number
  body?: unknown
  sse?: string
}

const makeFetch = (responses: FetchResponse[]): typeof fetch => {
  let i = 0
  return (async (url: unknown, _init?: unknown) => {
    const r = responses[i++] ?? responses[responses.length - 1]
    const status = r?.status ?? 200
    if (r?.sse !== undefined) {
      return new Response(r.sse, {
        status,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    return new Response(JSON.stringify(r?.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const basicRequest = (messages: ReadonlyArray<Message>): ChatRequest => ({
  messages,
  model: DEFAULT_MISTRAL_MODEL,
})

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

describe('Mistral defaults', () => {
  it('exposes the public base URL', () => {
    expect(DEFAULT_MISTRAL_BASE_URL).toBe('https://api.mistral.ai/v1')
  })

  it('defaults the chat model to mistral-large-latest', () => {
    expect(DEFAULT_MISTRAL_MODEL).toBe('mistral-large-latest')
  })

  it('defaults the embedding model to mistral-embed', () => {
    expect(DEFAULT_MISTRAL_EMBED_MODEL).toBe('mistral-embed')
  })

  it('uses the canonical provider id "mistral"', () => {
    expect(MISTRAL_PROVIDER_ID).toBe('mistral')
  })
})

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

describe('createMistralProvider', () => {
  it('returns a MistralProvider', () => {
    const provider = createMistralProvider({
      apiKey: 'k',
      defaultModel: 'mistral-large-latest',
    })
    expect(provider).toBeInstanceOf(MistralProvider)
  })

  it('pins id to Mistral default and routes requests to api.mistral.ai', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = (async (url: unknown) => {
      calls.push(String(url))
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const provider = createMistralProvider({
      apiKey: 'k',
      defaultModel: 'mistral-large-latest',
      fetchImpl,
    })
    expect(provider.id).toBe('mistral')
    // Drive a request purely to confirm routing; we don't care about parsing.
    await provider
      .chat(basicRequest([{ role: 'user', content: 'ping' }]))
      .catch(() => undefined)
    expect(calls[0]).toBe('https://api.mistral.ai/v1/chat/completions')
  })

  it('accepts overrides for baseUrl, id, and defaultModel', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = (async (url: unknown) => {
      calls.push(String(url))
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const provider = createMistralProvider({
      apiKey: 'k',
      defaultModel: 'mistral-small-latest',
      baseUrl: 'https://codestral.mistral.ai/v1',
      id: 'codestral',
      fetchImpl,
    })
    expect(provider.id).toBe('codestral')
    await provider
      .chat(
        Object.assign(basicRequest([{ role: 'user', content: 'ping' }]), {
          model: 'mistral-small-latest',
        }),
      )
      .catch(() => undefined)
    expect(calls[0]).toBe('https://codestral.mistral.ai/v1/chat/completions')
  })

  it('reports the expected capabilities', () => {
    const provider = createMistralProvider({
      apiKey: 'k',
      defaultModel: 'mistral-large-latest',
    })
    expect(provider.capabilities.streaming).toBe(true)
    expect(provider.capabilities.toolUse).toBe(true)
    expect(provider.capabilities.embeddings).toBe(true)
    // Mistral ships the Pixtral family (`pixtral-12b-2409`,
    // `pixtral-large-latest`) which accept image inputs; we advertise
    // vision support at the provider level even though individual chat
    // models may opt out.
    expect(provider.capabilities.vision).toBe(true)
  })
})

// -----------------------------------------------------------------------------
// HTTP behavior (reuses the OpenAI wire format)
// -----------------------------------------------------------------------------

describe('MistralProvider HTTP behavior', () => {
  it('POSTs to {baseUrl}/chat/completions with Authorization Bearer', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(
        JSON.stringify({
          id: 'r1',
          model: 'mistral-large-latest',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const provider = createMistralProvider({ apiKey: 'test-key', fetchImpl })
    const res = await provider.chat(
      basicRequest([{ role: 'user', content: 'hi' }]),
    )
    expect(res.message.content).toBe('hi')

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call).toBeDefined()
    expect(call?.url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(call?.init?.method).toBe('POST')
    // The provider passes a Record<string,string> for headers; the fetch
    // implementation may keep it as a plain object or upgrade to a Headers
    // instance. Handle both shapes.
    const rawHeaders = call?.init?.headers as
      | Record<string, string>
      | Headers
      | undefined
    const getHeader = (name: string): string | null => {
      if (!rawHeaders) return null
      if (typeof (rawHeaders as Headers).get === 'function') {
        return (rawHeaders as Headers).get(name)
      }
      const rec = rawHeaders as Record<string, string>
      return rec[name] ?? rec[name.toLowerCase()] ?? null
    }
    expect(getHeader('Authorization')).toBe('Bearer test-key')
    expect(getHeader('Content-Type')).toBe('application/json')
  })

  it('parses tool calls from the OpenAI-style response shape', async () => {
    const fetchImpl = makeFetch([
      {
        body: {
          id: 'r1',
          model: 'mistral-large-latest',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'tc_1',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: JSON.stringify({ path: '/x' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      },
    ])
    const provider = createMistralProvider({ apiKey: 'k', fetchImpl })
    const res = await provider.chat(
      basicRequest([{ role: 'user', content: 'read /x' }]),
    )
    expect(res.message.toolCalls).toHaveLength(1)
    expect(res.message.toolCalls[0]?.name).toBe('read_file')
    expect(res.message.toolCalls[0]?.arguments).toEqual({ path: '/x' })
    expect(res.message.finishReason).toBe('tool_calls')
  })

  it('propagates HTTP 401 as a ProviderError with HttpStatusError cause', async () => {
    const fetchImpl = makeFetch([{ status: 401, body: { error: 'unauthorized' } }])
    const provider = createMistralProvider({ apiKey: 'bad-key', fetchImpl })
    // The base class wraps the underlying HttpStatusError in a typed
    // ProviderError (carrying providerId/statusCode/retryable metadata),
    // so we assert on the wrapper shape rather than `instanceof`.
    let captured: unknown
    try {
      await provider.chat(basicRequest([{ role: 'user', content: 'hi' }]))
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(ProviderError)
    const err = captured as ProviderError & { cause?: unknown; statusCode?: number }
    expect(err.statusCode).toBe(401)
    expect(err.cause).toBeInstanceOf(HttpStatusError)
  })

  it('embeds with the mistral-embed model', async () => {
    const calls: Array<{ url: string; body: string }> = []
    const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) })
      return new Response(
        JSON.stringify({
          id: 'e1',
          model: 'mistral-embed',
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const provider = createMistralProvider({ apiKey: 'k', fetchImpl })
    const res = await provider.embed({
      input: ['hello'],
      model: DEFAULT_MISTRAL_EMBED_MODEL,
    })
    expect(res.vectors[0]).toEqual([0.1, 0.2, 0.3])
    expect(calls[0]?.url).toBe('https://api.mistral.ai/v1/embeddings')
    expect(calls[0]?.body).toContain('"model":"mistral-embed"')
  })
})
