/**
 * P34.3 (Phase B.3) — Trust / Plan snapshot formatters.
 *
 * Pure-data helpers that drive the `/trust` and
 * `/plan` TUI slash commands. No fs / no SqliteStore —
 * the helpers take a list of records / a PlanStore and
 * emit a one-line summary the Ink renderer can drop
 * into the chat log.
 */

import { type Plan, PlanStore } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import {
  aggregateTrustByKind,
  formatPlanLine,
  formatPlanSnapshot,
  formatTrustSnapshot,
} from '../src/components/trust-plan-snapshot.js'

describe('aggregateTrustByKind', () => {
  it('groups records by kind and computes stats', () => {
    const out = aggregateTrustByKind([
      { kind: 'agent', trust: 0.7 },
      { kind: 'agent', trust: 0.8 },
      { kind: 'reflection', trust: 0.5 },
      { kind: 'user', trust: 0.9 },
      { kind: 'user', trust: 1.0 },
    ])
    expect(out).toHaveLength(3)
    expect(out.find((k) => k.kind === 'agent')?.count).toBe(2)
    expect(out.find((k) => k.kind === 'agent')?.meanTrust).toBeCloseTo(0.75)
    expect(out.find((k) => k.kind === 'reflection')?.count).toBe(1)
    expect(out.find((k) => k.kind === 'user')?.minTrust).toBe(0.9)
    expect(out.find((k) => k.kind === 'user')?.maxTrust).toBe(1.0)
  })

  it('drops trust values outside [0, 1] (defensive)', () => {
    const out = aggregateTrustByKind([
      { kind: 'agent', trust: 1.5 }, // out of range — drop
      { kind: 'agent', trust: -0.2 }, // out of range — drop
      { kind: 'agent', trust: 0.7 },
    ])
    expect(out.find((k) => k.kind === 'agent')?.count).toBe(1)
  })

  it('returns an empty list for empty input', () => {
    expect(aggregateTrustByKind([])).toEqual([])
  })

  it('sorts kinds alphabetically', () => {
    const out = aggregateTrustByKind([
      { kind: 'user', trust: 0.9 },
      { kind: 'agent', trust: 0.7 },
      { kind: 'reflection', trust: 0.5 },
    ])
    expect(out.map((k) => k.kind)).toEqual(['agent', 'reflection', 'user'])
  })
})

describe('formatTrustSnapshot', () => {
  it('returns a friendly one-liner for empty input', () => {
    expect(formatTrustSnapshot({ records: [] })).toBe(
      '[trust] no records yet — run a multi-step agent loop to populate memory',
    )
  })

  it('emits the per-kind count + mean + min + max', () => {
    const out = formatTrustSnapshot({
      records: [
        { kind: 'agent', trust: 0.7 },
        { kind: 'agent', trust: 0.9 },
        { kind: 'reflection', trust: 0.4 },
      ],
    })
    expect(out).toContain('[trust] total=3 kinds=2')
    expect(out).toContain('agent')
    expect(out).toContain('reflection')
    expect(out).toContain('mean=0.80')
  })
})

describe('formatPlanLine + formatPlanSnapshot', () => {
  const plan1: Plan = {
    id: 'p-1',
    goal: 'Write README.md',
    steps: [
      { id: 's-1', description: 'draft' },
      { id: 's-2', description: 'review' },
      { id: 's-3', description: 'publish' },
    ],
    createdAt: 0,
  }
  const plan2: Plan = {
    id: 'p-2',
    goal: 'Add tests',
    steps: [
      { id: 's-1', description: 'unit' },
      { id: 's-2', description: 'integration' },
    ],
    createdAt: 0,
  }

  it('formats a plan line', () => {
    expect(formatPlanLine(plan1)).toBe('  p-1: Write README.md  steps=3')
  })

  it('returns friendly one-liner for empty store', () => {
    const store = new PlanStore()
    expect(formatPlanSnapshot(store)).toBe(
      '[plan] no plans yet — run an agent loop in `mode: auto` to see plans here',
    )
  })

  it('emits every saved plan with its step count', () => {
    const store = new PlanStore()
    store.save(plan1)
    store.save(plan2)
    const out = formatPlanSnapshot(store)
    expect(out).toContain('[plan] count=2')
    expect(out).toContain('p-1: Write README.md  steps=3')
    expect(out).toContain('p-2: Add tests  steps=2')
  })
})
