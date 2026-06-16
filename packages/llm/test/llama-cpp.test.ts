/**
 * Tests for {@link LlamaCppProvider}.
 *
 * The provider is a thin convenience wrapper over
 * {@link OpenAICompatibleProvider}; the test surface is therefore
 * mostly about constructor defaults, id, and the option pass-through
 * (e.g. an explicit baseUrl override wins over the default).
 */

import { describe, expect, it, vi } from 'vitest'

import { LlamaCppProvider, OpenAICompatibleProvider, createLlamaCppProvider } from '../src/index.js'

describe('LlamaCppProvider', () => {
  it('reports id = "llama-cpp" and defaults baseUrl to llama.cpp server', () => {
    const p = new LlamaCppProvider({ defaultModel: 'qwen2.5-7b-instruct' })
    expect(p.id).toBe('llama-cpp')
    // baseUrl is private on the parent class; we exercise it via a
    // chat round-trip and assert the URL the request hit.
    expect(p).toBeInstanceOf(OpenAICompatibleProvider)
  })

  it('hits http://127.0.0.1:8080/v1/chat/completions on chat()', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = vi.fn(async (input: unknown) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          model: 'qwen2.5-7b-instruct',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const p = new LlamaCppProvider({
      defaultModel: 'qwen2.5-7b-instruct',
      fetchImpl,
    })
    await p.chat({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'qwen2.5-7b-instruct',
    })
    expect(capturedUrl).toBe('http://127.0.0.1:8080/v1/chat/completions')
  })

  it('respects an explicit baseUrl override (remote llama.cpp server)', async () => {
    let capturedUrl: string | undefined
    const fetchImpl = vi.fn(async (input: unknown) => {
      capturedUrl = String(input)
      return new Response(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const p = new LlamaCppProvider({
      defaultModel: 'm',
      baseUrl: 'http://10.0.0.5:9000/v1',
      fetchImpl,
    })
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
    expect(capturedUrl).toBe('http://10.0.0.5:9000/v1/chat/completions')
  })

  it('attaches Authorization: Bearer when apiKey is supplied (gated deployments)', async () => {
    const capturedHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      const headers = (init as { headers?: Headers | Record<string, string> } | undefined)?.headers
      if (headers instanceof Headers) {
        for (const [k, v] of headers.entries()) capturedHeaders[k] = v
      } else if (headers) {
        Object.assign(capturedHeaders, headers as Record<string, string>)
      }
      return new Response(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const p = new LlamaCppProvider({ defaultModel: 'm', apiKey: 'secret', fetchImpl })
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
    expect(capturedHeaders['authorization']).toBe('Bearer secret')
  })

  it('omits Authorization header when no apiKey (typical local-server case)', async () => {
    const capturedHeaders: Record<string, string> = {}
    const fetchImpl = vi.fn(async (_url: unknown, init?: unknown) => {
      const headers = (init as { headers?: Headers | Record<string, string> } | undefined)?.headers
      if (headers instanceof Headers) {
        for (const [k, v] of headers.entries()) capturedHeaders[k] = v
      } else if (headers) {
        Object.assign(capturedHeaders, headers as Record<string, string>)
      }
      return new Response(
        JSON.stringify({
          id: 'cmpl-1',
          object: 'chat.completion',
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const p = new LlamaCppProvider({ defaultModel: 'm', fetchImpl })
    await p.chat({ messages: [{ role: 'user', content: 'hi' }], model: 'm' })
    expect(capturedHeaders['authorization']).toBeUndefined()
  })

  it('createLlamaCppProvider returns a configured instance', () => {
    const p = createLlamaCppProvider({ defaultModel: 'm' })
    expect(p).toBeInstanceOf(LlamaCppProvider)
    expect(p.id).toBe('llama-cpp')
  })
})
