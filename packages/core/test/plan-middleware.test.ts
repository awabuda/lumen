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
    // P31.6B — the injected PLAN_PROMPT lands in the system
    // message's dynamic suffix (post-marker) via the
    // `appendDynamicChunk` surface. We pin it on the system
    // message at index 0 rather than the trailing user
    // message.
    const sys0 = provider.calls[0]?.messages[0]
    expect(sys0?.role).toBe('system')
    const sysContent = sys0 && 'content' in sys0 && typeof sys0.content === 'string'
      ? sys0.content
      : ''
    expect(sysContent).toContain('You are in plan mode')
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
    // P31.6B R3 — the auto-mode plan context is appended to
    // the dynamic suffix of the system message (post-marker)
    // via `appendDynamicChunk`, so we look for the trigger
    // phrase in the system message rather than the trailing
    // user message.
    const sys1 = provider.calls[1]?.messages[0]
    const sys1Content = sys1 && 'content' in sys1 && typeof sys1.content === 'string'
      ? sys1.content
      : ''
    expect(sys1Content).toContain('Approved plan')
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
    // P31.6B R3 — see sibling test for rationale. The
    // planner-generated plan context lands in the system
    // message's dynamic suffix on the next model call.
    const sysPlanner = provider.calls[0]?.messages[0]
    const sysPlannerContent = sysPlanner && 'content' in sysPlanner && typeof sysPlanner.content === 'string'
      ? sysPlanner.content
      : ''
    expect(sysPlannerContent).toContain('Approved plan')
  })
})
