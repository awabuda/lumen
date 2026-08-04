/**
 * P34.9.b — `/state` slash command tests.
 *
 * Verifies the three read-only state surfaces the
 * command reads:
 *   - Budget snapshot (P23.12).
 *   - PlanStore snapshot (P34.3).
 *   - Memory record count (P34.1 markdown-bridge hooks).
 *
 * The test is hermetic: it builds a minimal `BuiltAgent`
 * stub with the three fields actually consumed by
 * `handleStateSlash` and asserts the formatted output.
 */

import { describe, expect, it } from 'vitest'
import { handleStateSlash } from '../src/components/slash-commands.js'
import type { BuiltAgent } from '../src/composition.js'

const stubBuilt = (overrides: Partial<BuiltAgent> = {}): BuiltAgent => {
  const base = {
    agent: {
      budgetSnapshot: () => undefined,
    },
    planStore: undefined,
    memory: undefined,
    model: 'test-model',
    tools: new Map(),
    config: {} as BuiltAgent['config'],
    hooks: {} as BuiltAgent['hooks'],
    mcpServers: [],
  } as unknown as BuiltAgent
  return { ...base, ...overrides } as BuiltAgent
}

describe('handleStateSlash — P34.9.b', () => {
  it('reports every surface as "no data yet" when stubs are empty', async () => {
    const result = await handleStateSlash(stubBuilt())
    expect(result.message).toMatch(/\[state\] budget: no runs yet/)
    expect(result.message).toMatch(/\[state\] plan: no plan middleware mounted/)
    expect(result.message).toMatch(/\[state\] memory: no memory store configured/)
  })

  it('surfaces a budget snapshot when the agent has one', async () => {
    const built = stubBuilt({
      agent: {
        budgetSnapshot: () =>
          ({
            used: 1234,
            costUsdConsumed: () => 0.012,
            timeMsConsumed: () => 456,
          }) as unknown as ReturnType<BuiltAgent['agent']['budgetSnapshot']>,
      },
    } as Partial<BuiltAgent>)
    const result = await handleStateSlash(built)
    expect(result.message).toMatch(/\[state\] budget: tokens=1234/)
    expect(result.message).toMatch(/cost=\$/)
    expect(result.message).toMatch(/time=456ms/)
  })

  it('reports the plan count when a PlanStore is mounted', async () => {
    const fakePlanStore = {
      all: [
        { id: 'p-1', steps: [] },
        { id: 'p-2', steps: [] },
      ],
    }
    const built = stubBuilt({
      planStore: fakePlanStore as unknown as BuiltAgent['planStore'],
    })
    const result = await handleStateSlash(built)
    expect(result.message).toMatch(/\[state\] plan: count=2/)
  })

  it('summarises memory records by kind', async () => {
    const search = async () =>
      [
        { record: { kind: 'fact' }, score: 1 },
        { record: { kind: 'fact' }, score: 1 },
        { record: { kind: 'reflection' }, score: 1 },
      ] as never
    const built = stubBuilt({
      memory: { search } as unknown as BuiltAgent['memory'],
    })
    const result = await handleStateSlash(built)
    expect(result.message).toMatch(/\[state\] memory: total=3 fact=2 reflection=1/)
  })

  it('reports empty memory when the store has no records', async () => {
    const built = stubBuilt({
      memory: { search: async () => [] as never } as unknown as BuiltAgent['memory'],
    })
    const result = await handleStateSlash(built)
    expect(result.message).toMatch(/\[state\] memory: total=0/)
  })

  it('reports a memory read failure without throwing', async () => {
    const built = stubBuilt({
      memory: {
        search: async () => {
          throw new Error('disk full')
        },
      } as unknown as BuiltAgent['memory'],
    })
    const result = await handleStateSlash(built)
    expect(result.message).toMatch(/\[state\] memory: read failed \(disk full\)/)
  })
})
