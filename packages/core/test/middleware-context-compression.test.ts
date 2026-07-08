/** P20.3 e2e: context compression middleware. */

import { describe, expect, it } from 'vitest'
import { Agent, type AssistantMessage, type Message, ToolRegistry } from '../src/index.js'
import { FakeProvider } from './fake-provider.js'

const longHistory = (n: number): ReadonlyArray<Message> => {
  const out: Message[] = []
  for (let i = 0; i < n; i += 1) {
    if (i % 2 === 0) {
      out.push({ role: 'user', content: `user-${i}-${'x'.repeat(50)}` })
    } else {
      out.push({
        role: 'assistant',
        content: `assistant-${i}-${'y'.repeat(50)}`,
        toolCalls: [],
      } as AssistantMessage)
    }
  }
  return out
}

describe('createContextCompressionMiddleware', () => {
  it('passes messages through when under the cap', async () => {
    // The middleware is opaque to callers; we exercise it
    // through a full agent.run with a small history and assert
    // the provider sees the un-compressed messages.
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'ok', toolCalls: [] } },
    ])
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    // Inject a small history by pre-seeding... actually the
    // simplest way is to call the middleware's beforeModel
    // directly. We import it dynamically to avoid the circular
    // import on AgentMiddleware in the source.
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    const m = createContextCompressionMiddleware({ maxMessages: 5, keepLastN: 2 })
    const out = await m.beforeModel!(longHistory(3), {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(out).toHaveLength(3)
  })

  it('compresses when over the cap and keeps the last N messages', async () => {
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    const m = createContextCompressionMiddleware({ maxMessages: 10, keepLastN: 3 })
    const input = longHistory(20)
    const out = await m.beforeModel!(input, {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    // 1 summary + 3 kept = 4 messages.
    expect(out).toHaveLength(4)
    expect(out[0]?.role).toBe('system')
    const summary = out[0]
    if (summary && summary.role === 'system') {
      expect(summary.content).toContain('17 message(s) collapsed')
    }
    // The last 3 input messages are preserved verbatim, in order.
    const kept = input.slice(-3)
    expect(out.slice(1)).toEqual(kept)
  })

  it('accepts a custom summaryFn', async () => {
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    const m = createContextCompressionMiddleware({
      maxMessages: 4,
      keepLastN: 2,
      summaryFn: (msgs) => `custom-summary of ${msgs.length}`,
    })
    const out = await m.beforeModel!(longHistory(6), {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(out).toHaveLength(3)
    expect(out[0]?.role).toBe('system')
    const summary = out[0]
    if (summary && summary.role === 'system') {
      expect(summary.content).toBe('custom-summary of 4')
    }
  })

  it('rejects keepLastN >= maxMessages at construction', async () => {
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    expect(() =>
      createContextCompressionMiddleware({ maxMessages: 5, keepLastN: 5 }),
    ).toThrow(/keepLastN/)
    expect(() =>
      createContextCompressionMiddleware({ maxMessages: 5, keepLastN: 10 }),
    ).toThrow(/keepLastN/)
  })

  it('rejects non-positive maxMessages and keepLastN at the Zod layer', async () => {
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    expect(() => createContextCompressionMiddleware({ maxMessages: 0 })).toThrow()
    expect(() => createContextCompressionMiddleware({ keepLastN: 0 })).toThrow()
  })

  it('exposes name "context-compression"', async () => {
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    expect(createContextCompressionMiddleware().name).toBe('context-compression')
  })

  it('the compressed message count is exactly keepLastN+1 (summary + tail)', async () => {
    const { createContextCompressionMiddleware } = await import(
      '../src/agent/middleware/context-compression.js'
    )
    const m = createContextCompressionMiddleware({ maxMessages: 50, keepLastN: 7 })
    const out = await m.beforeModel!(longHistory(100), {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(out).toHaveLength(1 + 7)
  })
})
