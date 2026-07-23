/**
 * P25.1 \u2014 sub-agent context isolation (bug.md #37).
 *
 * Verifies the SubAgentContext schema + helpers without
 * spinning up an agent. The agent-level wiring is exercised
 * via the existing sub-agent tests; this file pins the
 * data-layer contract.
 */

import { describe, expect, it } from 'vitest'

import {
  SubAgentContextSchema,
  appendToSubAgent,
  createSubAgentContext,
  filterToSubAgent,
  memoSet,
} from '../src/multi-user/sub-context.js'

describe('P25.1 \u2014 SubAgentContextSchema', () => {
  it('rejects an empty subAgentId', () => {
    const r = SubAgentContextSchema.safeParse({
      subAgentId: '',
      history: [],
      memo: {},
      createdAtMs: 1,
    })
    expect(r.success).toBe(false)
  })

  it('rejects an extra field (strict)', () => {
    const r = SubAgentContextSchema.safeParse({
      subAgentId: 'a',
      history: [],
      memo: {},
      createdAtMs: 1,
      rogue: 'x',
    })
    expect(r.success).toBe(false)
  })
})

describe('createSubAgentContext', () => {
  it('seeds defaults for history / memo / createdAtMs', () => {
    const now = 1_700_000_000_000
    const slice = createSubAgentContext({
      subAgentId: 'explore-1',
      now: () => now,
    })
    expect(slice.subAgentId).toBe('explore-1')
    expect(slice.history).toEqual([])
    expect(slice.memo).toEqual({})
    expect(slice.createdAtMs).toBe(now)
  })

  it('passes through optional label', () => {
    const slice = createSubAgentContext({
      subAgentId: 'plan-2',
      label: 'planner sub-agent',
    })
    expect(slice.label).toBe('planner sub-agent')
  })
})

describe('appendToSubAgent', () => {
  it('appends a message and stamps lastWriteMs', () => {
    const slice = createSubAgentContext({
      subAgentId: 'a',
      now: () => 100,
    })
    const next = appendToSubAgent(
      slice,
      { role: 'user', content: 'hi' },
      () => 200,
    )
    expect(next.history).toHaveLength(1)
    expect(next.history[0]).toEqual({ role: 'user', content: 'hi' })
    expect(next.lastWriteMs).toBe(200)
    // Original slice is untouched (immutability).
    expect(slice.history).toHaveLength(0)
  })
})

describe('memoSet', () => {
  it('writes a memo key without mutating the slice', () => {
    const slice = createSubAgentContext({ subAgentId: 'a' })
    const next = memoSet(slice, 'cache', 42)
    expect(next.memo['cache']).toBe(42)
    expect(slice.memo).toEqual({})
  })

  it('preserves sibling memo keys', () => {
    const slice = memoSet(
      createSubAgentContext({ subAgentId: 'a' }),
      'first',
      'one',
    )
    const next = memoSet(slice, 'second', 'two')
    expect(next.memo).toEqual({ first: 'one', second: 'two' })
  })
})

describe('filterToSubAgent', () => {
  it('keeps only messages tagged with the sub-agent id', () => {
    // biome-ignore lint/suspicious/noExplicitAny: meta is untyped
    const msgs: any[] = [
      { role: 'user', content: 'parent msg' },
      { role: 'assistant', content: 'parent assistant', toolCalls: [], meta: { subAgentId: 'parent' } },
      { role: 'assistant', content: 'child assistant', toolCalls: [], meta: { subAgentId: 'child' } },
      { role: 'assistant', content: 'no-meta assistant', toolCalls: [] },
    ]
    // biome-ignore lint/suspicious/noExplicitAny: narrowed via `as any`
    const out = filterToSubAgent(msgs as any, 'child')
    // user msg has no meta → kept (parent conversation);
    // 'parent assistant' has meta.subAgentId='parent' → dropped;
    // 'child assistant' has meta.subAgentId='child' → kept;
    // 'no-meta assistant' has no meta → kept (parent conversation).
    expect(out).toHaveLength(3)
    // biome-ignore lint/suspicious/noExplicitAny: content may be string | array
    const texts = (out as any[]).map((m) => (typeof m.content === 'string' ? m.content : null))
    expect(texts).toEqual(['parent msg', 'child assistant', 'no-meta assistant'])
  })
})