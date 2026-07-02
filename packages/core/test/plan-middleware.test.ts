import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/factory.js'
import { createPlanMiddleware } from '../src/agent/middleware/plan.js'
import { PlanStore, createStaticPlanner } from '../src/plan/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'
import { EchoTool } from './fake-tools.js'

const staticPlan = {
  id: 'p-static',
  goal: 'goal',
  steps: [{ id: 's1', description: 'do the thing' }],
  createdAt: 0,
}

describe('PlanMiddleware', () => {
  it('plan mode injects a planning prompt and suppresses tool calls', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '<plan id="p1">\n- s1: read input\n</plan>',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'should-not-run' } }],
        },
      },
    ])
    const store = new PlanStore()
    const agent = createAgent({
      provider,
      tools: new ToolRegistry().register(new EchoTool()),
      middleware: [createPlanMiddleware({ mode: 'plan', planStore: store })],
    })

    const result = await agent.run({ userMessage: 'make a plan' })

    expect(result.iterations).toBe(1)
    expect(result.finalMessage.toolCalls).toEqual([])
    expect(provider.calls[0]?.messages.at(-1)?.content).toContain('You are in plan mode')
    expect(store.get('p1')?.steps[0]?.description).toBe('read input')
  })

  it('act mode is a no-op and allows tool execution', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'ping' } }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry().register(new EchoTool()),
      middleware: [createPlanMiddleware({ mode: 'act' })],
    })

    const result = await agent.run({ userMessage: 'echo please' })

    expect(result.iterations).toBe(2)
    expect(result.finalMessage.content).toBe('done')
    expect(provider.calls[1]?.messages.some((m) => m.role === 'tool')).toBe(true)
  })

  it('auto mode continues after planning and then acts', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '<plan id="p-auto">\n- s1: echo ping\n</plan>',
          toolCalls: [],
        },
      },
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'ping' } }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const store = new PlanStore()
    const agent = createAgent({
      provider,
      tools: new ToolRegistry().register(new EchoTool()),
      middleware: [createPlanMiddleware({ mode: 'auto', planStore: store })],
    })

    const result = await agent.run({ userMessage: 'plan then act' })

    expect(result.iterations).toBe(3)
    expect(result.finalMessage.content).toBe('done')
    expect(store.get('p-auto')).toBeDefined()
    expect(provider.calls[1]?.messages.at(-1)?.content).toContain('Approved plan')
  })

  it('planner option generates a plan without asking the model to write XML first', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'ping' } }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const planner = createStaticPlanner({ plan: staticPlan })
    const store = new PlanStore()
    const agent = createAgent({
      provider,
      tools: new ToolRegistry().register(new EchoTool()),
      middleware: [createPlanMiddleware({ mode: 'auto', planner, planStore: store })],
    })

    const result = await agent.run({ userMessage: 'use provided planner' })

    expect(result.iterations).toBe(2)
    expect(store.get('p-static')).toBeDefined()
    expect(provider.calls[0]?.messages.at(-1)?.content).toContain('Approved plan')
  })
})
