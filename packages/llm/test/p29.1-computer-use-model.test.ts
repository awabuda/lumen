/**
 * P29.1 (bug.md #10 Path A) — Computer Use model interface.
 *
 * Pure data-layer tests. The Anthropic / OpenAI / OSS
 * adapters ship as separate P29.1.x commits once the
 * user picks the vendor; this file pins the surface
 * the agent loop composes against.
 */

import { describe, expect, it } from 'vitest'

import {
  AnthropicComputerUseModel,
  ComputerActionSchema,
  ComputerUseModelInputSchema,
  StubComputerUseModel,
} from '../src/computer-use/index.js'

describe('P29.1 — ComputerActionSchema', () => {
  it('accepts a click action', () => {
    const r = ComputerActionSchema.safeParse({
      type: 'click',
      x: 100,
      y: 100,
    })
    expect(r.success).toBe(true)
  })

  it('rejects a click with negative coordinates', () => {
    expect(
      ComputerActionSchema.safeParse({
        type: 'click',
        x: -1,
        y: 0,
      }).success,
    ).toBe(false)
  })

  it('accepts a type action with non-empty text', () => {
    expect(
      ComputerActionSchema.safeParse({ type: 'type', text: 'hello' }).success,
    ).toBe(true)
  })

  it('rejects a type action with empty text', () => {
    expect(
      ComputerActionSchema.safeParse({ type: 'type', text: '' }).success,
    ).toBe(false)
  })

  it('accepts a stop action with optional reason', () => {
    expect(
      ComputerActionSchema.safeParse({ type: 'stop' }).success,
    ).toBe(true)
    expect(
      ComputerActionSchema.safeParse({ type: 'stop', reason: 'done' })
        .success,
    ).toBe(true)
  })
})

describe('P29.1 — ComputerUseModelInputSchema', () => {
  it('accepts a minimal valid input', () => {
    const r = ComputerUseModelInputSchema.safeParse({
      screenshot: 'AAAA',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.history).toEqual([])
    }
  })

  it('rejects an empty screenshot', () => {
    expect(
      ComputerUseModelInputSchema.safeParse({ screenshot: '' }).success,
    ).toBe(false)
  })

  it('accepts a history', () => {
    const r = ComputerUseModelInputSchema.safeParse({
      screenshot: 'AAAA',
      history: [
        { action: { type: 'click', x: 10, y: 10 } },
        { action: { type: 'type', text: 'alice' } },
      ],
      hint: 'log in',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.history).toHaveLength(2)
      expect(r.data.hint).toBe('log in')
    }
  })
})

describe('P29.1 — AnthropicComputerUseModel (stub)', () => {
  it('id is "anthropic" and hosted is true', () => {
    const m = AnthropicComputerUseModel()
    expect(m.id).toBe('anthropic')
    expect(m.hosted).toBe(true)
  })

  it('returns the canned stub action', async () => {
    const m = AnthropicComputerUseModel({
      stubAction: { type: 'key', key: 'Enter' },
    })
    const out = await m.nextAction({ screenshot: 'AAAA' })
    expect(out.type).toBe('key')
    if (out.type === 'key') expect(out.key).toBe('Enter')
  })
})

describe('P29.1 — StubComputerUseModel', () => {
  it('id is "stub" and hosted is false', () => {
    const m = StubComputerUseModel()
    expect(m.id).toBe('stub')
    expect(m.hosted).toBe(false)
  })

  it('returns a stop action by default', async () => {
    const m = StubComputerUseModel()
    const out = await m.nextAction({ screenshot: 'AAAA' })
    expect(out.type).toBe('stop')
  })

  it('returns the canned action when supplied', async () => {
    const m = StubComputerUseModel({
      action: { type: 'click', x: 50, y: 50 },
    })
    const out = await m.nextAction({ screenshot: 'AAAA' })
    expect(out.type).toBe('click')
  })
})