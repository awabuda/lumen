/**
 * P31.6B R3 — context-compression middleware wire-shape
 * invariant.
 *
 * Adds a third R3 case alongside the skill-trigger cases
 * already in this file: context-compression now writes the
 * summary to the dynamic suffix via `appendDynamicChunk`
 * instead of prepending a standalone `{role: 'system'}`
 * message. The wire shape must hold for any future
 * migration.
 */

import { describe, expect, it } from 'vitest'
import { type Message } from '../src/message/index.js'
import { createContextCompressionMiddleware } from '../src/agent/middleware/context-compression.js'

describe('P31.6B R3 — context-compression wire shape', () => {
  it('writes the summary to the dynamic suffix, not a separate role:system message', async () => {
    const long = (n: number): Message[] =>
      Array.from({ length: n }, (_, i) => ({
        role: 'user' as const,
        content: `user-${i}-${'x'.repeat(80)}`,
      }))
    const m = createContextCompressionMiddleware({
      maxMessages: 5,
      keepLastN: 2,
    })
    const chunks: string[] = []
    const out = await m.beforeModel!(long(20), {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
      // biome-ignore lint/suspicious/noExplicitAny: test scaffolding only.
      appendDynamicChunk: (chunk: string) => chunks.push(chunk),
    } as any)
    // R3 invariant: no role:system message in the result;
    // the summary is in the chunks.
    expect(out.some((msg) => msg.role === 'system')).toBe(false)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('collapsed')
  })

  it('passes through when the message count is under the cap (no chunk write)', async () => {
    const short: Message[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    const m = createContextCompressionMiddleware({
      maxMessages: 5,
      keepLastN: 2,
    })
    const chunks: string[] = []
    const out = await m.beforeModel!(short, {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
      // biome-ignore lint/suspicious/noExplicitAny: test scaffolding only.
      appendDynamicChunk: (chunk: string) => chunks.push(chunk),
    } as any)
    expect(chunks).toHaveLength(0)
    expect(out).toEqual(short)
  })
})
