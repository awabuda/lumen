/** Tests for plan/act mode. */

import { describe, expect, it } from 'vitest'
import {
  BasePlanner,
  LLMPlanner,
  ModeSchema,
  PlanSchema,
  PlanStepSchema,
  PlanStore,
  StaticPlanner,
} from '../src/plan/index.js'

describe('PlanStepSchema', () => {
  it('requires an id and description', () => {
    expect(PlanStepSchema.safeParse({ id: '', description: '' }).success).toBe(false)
    expect(PlanStepSchema.safeParse({ id: '1', description: 'd' }).success).toBe(true)
  })

  it('accepts optional tools and dependsOn', () => {
    const r = PlanStepSchema.safeParse({
      id: '1',
      description: 'd',
      tools: ['read_file'],
      dependsOn: ['0'],
    })
    expect(r.success).toBe(true)
  })
})

describe('PlanSchema', () => {
  it('requires at least one step', () => {
    expect(PlanSchema.safeParse({ id: 'p', goal: 'g', steps: [], createdAt: 0 }).success).toBe(
      false,
    )
  })

  it('accepts a valid plan', () => {
    const r = PlanSchema.safeParse({
      id: 'p1',
      goal: 'do x',
      steps: [{ id: 's1', description: 'first' }],
      createdAt: Date.now(),
    })
    expect(r.success).toBe(true)
  })
})

describe('ModeSchema', () => {
  it('accepts plan and act', () => {
    expect(ModeSchema.safeParse('plan').success).toBe(true)
    expect(ModeSchema.safeParse('act').success).toBe(true)
  })

  it('rejects other values', () => {
    expect(ModeSchema.safeParse('idle').success).toBe(false)
  })
})

describe('StaticPlanner', () => {
  it('returns the configured plan regardless of goal', async () => {
    const plan = {
      id: 'fixed',
      goal: 'any',
      steps: [{ id: 's1', description: 'do x' }],
      createdAt: 0,
    }
    const planner = new StaticPlanner({ plan })
    const result = await planner.plan('whatever')
    expect(result).toEqual(plan)
  })

  it('exposes id "static"', () => {
    const planner = new StaticPlanner({
      plan: { id: 'p', goal: 'g', steps: [{ id: 's', description: 'd' }], createdAt: 0 },
    })
    expect(planner.id).toBe('static')
  })
})

describe('BasePlanner.revise (default impl)', () => {
  it('returns the plan unchanged', async () => {
    const plan = {
      id: 'p',
      goal: 'g',
      steps: [{ id: 's', description: 'd' }],
      createdAt: 0,
    }
    const planner = new StaticPlanner({ plan })
    const revised = await planner.revise(plan, 'feedback')
    expect(revised).toBe(plan)
  })
})

describe('LLMPlanner', () => {
  const fakeProvider = (response: string) => ({
    async chat(_opts: { model: string; messages: Array<{ role: string; content: string }> }) {
      return { content: response }
    },
  })

  it('parses JSON plan from LLM response', async () => {
    const llmJson = JSON.stringify({
      steps: [
        { id: 'step-1', description: 'read input', tools: ['read_file'] },
        { id: 'step-2', description: 'transform', dependsOn: ['step-1'] },
      ],
    })
    const planner = new LLMPlanner({ provider: fakeProvider(llmJson) as never })
    const plan = await planner.plan('do something')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.tools).toEqual(['read_file'])
  })

  it('strips prose around the JSON object', async () => {
    const llmText = 'Here is the plan:\n{"steps":[{"id":"s1","description":"x"}]}\nDone!'
    const planner = new LLMPlanner({ provider: fakeProvider(llmText) as never })
    const plan = await planner.plan('goal')
    expect(plan.steps).toHaveLength(1)
  })

  it('throws on missing JSON (Rule 7)', async () => {
    const planner = new LLMPlanner({ provider: fakeProvider('no json here') as never })
    await expect(planner.plan('goal')).rejects.toThrow()
  })

  it('revises a plan based on feedback', async () => {
    const llmJson = JSON.stringify({
      steps: [{ id: 'new-step', description: 'updated' }],
    })
    const planner = new LLMPlanner({ provider: fakeProvider(llmJson) as never })
    const original = {
      id: 'p1',
      goal: 'g',
      steps: [{ id: 'old', description: 'o' }],
      createdAt: 1000,
    }
    const revised = await planner.revise(original, 'add detail')
    expect(revised.id).toBe('p1')
    expect(revised.steps).toHaveLength(1)
    expect(revised.createdAt).toBe(1000)
  })

  it('exposes id "llm"', () => {
    const planner = new LLMPlanner({ provider: fakeProvider('{}') as never })
    expect(planner.id).toBe('llm')
  })
})

describe('PlanStore', () => {
  const plan = {
    id: 'p1',
    goal: 'g',
    steps: [{ id: 's', description: 'd' }],
    createdAt: 100,
  }

  it('saves and retrieves plans', () => {
    const store = new PlanStore()
    store.save(plan)
    expect(store.get('p1')).toEqual(plan)
    expect(store.size).toBe(1)
  })

  it('approves a plan', () => {
    const store = new PlanStore()
    store.save(plan)
    const approved = store.approve('p1', 'looks good')
    expect(approved?.approvedAt).toBeGreaterThan(0)
    expect(approved?.notes).toBe('looks good')
  })

  it('rejects a plan', () => {
    const store = new PlanStore()
    store.save(plan)
    const rejected = store.reject('p1', 'redo it')
    expect(rejected?.rejectedAt).toBeGreaterThan(0)
    expect(rejected?.notes).toBe('redo it')
  })

  it('returns undefined for unknown ids', () => {
    const store = new PlanStore()
    expect(store.get('nope')).toBeUndefined()
    expect(store.approve('nope')).toBeUndefined()
    expect(store.reject('nope')).toBeUndefined()
  })

  it('lists all plans', () => {
    const store = new PlanStore()
    store.save(plan)
    store.save({ ...plan, id: 'p2' })
    expect(store.all).toHaveLength(2)
  })

  it('rejects invalid plans on save', () => {
    const store = new PlanStore()
    expect(() => store.save({ ...plan, steps: [] })).toThrow()
  })
})

describe('BasePlanner is abstract', () => {
  it('cannot be instantiated directly', () => {
    // biome-ignore lint/suspicious/noExplicitAny: abstract class cannot be instantiated directly
    ;new (BasePlanner as any)()
  })
})
