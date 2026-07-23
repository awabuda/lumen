/**
 * P25.9 — Proactive Agent wrapper (bug.md #51).
 *
 * Pure helper tests. The full agent-loop wake-up cycle
 * is exercised by the existing provider/agent tests; this
 * file pins the wrapper's helpers.
 */

import { describe, expect, it } from 'vitest'

import { exceedsHourlyBudget, runWakeup } from '../src/agent/proactive.js'
import { Agent } from '../src/agent/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider, type ScriptedStep } from './fake-provider.js'

// ---------------------------------------------------------------------------
// exceedsHourlyBudget
// ---------------------------------------------------------------------------

describe('P25.9 — exceedsHourlyBudget', () => {
  it('returns false when no wake-ups happened in the last hour', () => {
    expect(exceedsHourlyBudget([], 10_000, 5)).toBe(false)
  })

  it('returns false when recent wake-ups are below the cap', () => {
    const now = 1_000_000
    const recent = [now - 100, now - 200, now - 300]
    expect(exceedsHourlyBudget(recent, now, 5)).toBe(false)
  })

  it('returns true when recent wake-ups are at the cap', () => {
    const now = 1_000_000
    const recent = [now - 100, now - 200, now - 300, now - 400, now - 500]
    expect(exceedsHourlyBudget(recent, now, 5)).toBe(true)
  })

  it('does NOT count wake-ups older than one hour', () => {
    const now = 1_000_000
    const recent = [
      now - 3_700_000,
      now - 3_800_000,
      now - 3_900_000,
      now - 100,
      now - 200,
    ]
    // 5 total but only 2 within the hour; budget is 5.
    expect(exceedsHourlyBudget(recent, now, 5)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// runWakeup
// ---------------------------------------------------------------------------

const scriptedActStep = (content: string): ScriptedStep => ({
  message: { role: 'assistant', content, toolCalls: [] },
})

describe('P25.9 — runWakeup', () => {
  it('runs the agent with the prompted prompt and returns a record', async () => {
    const provider = new FakeProvider([scriptedActStep('ACT: do the thing')])
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: 'fake' })
    const rec = await runWakeup({
      agent,
      shouldWake: () => true,
      buildPrompt: (now) => `wake at ${now}`,
      decideAct: (response) => response.startsWith('ACT:'),
      now: () => 1_700_000_000_000,
    })
    expect(rec.acted).toBe(true)
    expect(rec.summary).toBe('ACT: do the thing')
    expect(rec.wakeAtMs).toBe(1_700_000_000_000)
    expect(rec.durationMs).toBe(0)
    expect(provider.calls).toHaveLength(1)
    expect(provider.calls[0]?.messages.at(-1)?.role).toBe('user')
  })

  it('marks noop when the decideAct predicate returns false', async () => {
    const provider = new FakeProvider([scriptedActStep('nothing to do')])
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: 'fake' })
    const rec = await runWakeup({
      agent,
      shouldWake: () => true,
      buildPrompt: () => 'tick',
      decideAct: () => false,
      now: () => 1_700_000_000_000,
    })
    expect(rec.acted).toBe(false)
    expect(rec.summary).toBe('nothing to do')
  })

  it('passes the user-supplied AbortController budget to the agent', async () => {
    const provider = new FakeProvider([
      scriptedActStep('slow'),
      scriptedActStep('done'),
    ])
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: 'fake' })
    // Tiny budget; the FakeProvider's first step has no
    // delay, so this should succeed (the budget aborts
    // AFTER the chat returns; the chat itself does not
    // block long enough to hit the budget).
    const rec = await runWakeup({
      agent,
      shouldWake: () => true,
      buildPrompt: () => 'tick',
      decideAct: () => true,
      perWakeTimeoutMs: 100,
      now: () => 1_700_000_000_000,
    })
    expect(rec.acted).toBe(true)
  })
})