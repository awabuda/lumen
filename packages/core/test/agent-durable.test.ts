/** P21.0 durable execution integration tests. */
import { describe, expect, it, vi } from 'vitest'
import {
  AgentCheckpointSchema,
  type AgentMiddleware,
  InMemoryCheckpointStore,
  ToolRegistry,
  createAgent,
} from '../src/index.js'
import { FakeProvider } from './fake-provider.js'
import { EchoTool } from './fake-tools.js'

const tools = (): ToolRegistry => {
  const registry = new ToolRegistry()
  registry.register(new EchoTool())
  return registry
}

const twoStepScript = () => [
  {
    message: {
      role: 'assistant' as const,
      content: 'calling tool',
      toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
    },
  },
  {
    message: {
      role: 'assistant' as const,
      content: 'done',
      toolCalls: [],
    },
  },
]

const outcomeCounts = (items: ReadonlyArray<{ outcome?: string }>) => ({
  inProgress: items.filter((item) => item.outcome === 'in_progress').length,
  success: items.filter((item) => item.outcome === 'success').length,
  error: items.filter((item) => item.outcome === 'error').length,
})

describe('Agent.run step-level checkpoint', () => {
  it('saves every completed step and marks the terminal snapshot as success', async () => {
    const store = new InMemoryCheckpointStore()
    const result = await createAgent({
      provider: new FakeProvider(twoStepScript()),
      tools: tools(),
      model: 'fake-model',
    }).run({ userMessage: 'go', sessionId: 'dur-1', checkpointStore: store })

    expect(result.iterations).toBe(2)
    const list = await store.list('dur-1')
    expect(outcomeCounts(list)).toEqual({ inProgress: 1, success: 1, error: 0 })
    expect(list.find((item) => item.iterations === 1)?.messages.at(-1)?.role).toBe('tool')
    expect(list.find((item) => item.outcome === 'success')?.iterations).toBe(2)
  })

  it('saves only every Nth in-progress step when checkpointInterval is greater than one', async () => {
    const store = new InMemoryCheckpointStore()
    await createAgent({
      provider: new FakeProvider(twoStepScript()),
      tools: tools(),
      model: 'fake-model',
    }).run({
      userMessage: 'go',
      sessionId: 'dur-2',
      checkpointStore: store,
      checkpointInterval: 2,
    })

    const list = await store.list('dur-2')
    expect(outcomeCounts(list)).toEqual({ inProgress: 0, success: 1, error: 0 })
  })

  it.each([0, -1, 1.5])('rejects invalid checkpointInterval %s', async (checkpointInterval) => {
    const agent = createAgent({
      provider: new FakeProvider([
        { message: { role: 'assistant', content: 'ok', toolCalls: [] } },
      ]),
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    await expect(agent.run({ userMessage: 'go', checkpointInterval })).rejects.toThrow(
      'checkpointInterval must be a positive integer',
    )
  })

  it('keeps the original run error and records an error outcome', async () => {
    const store = new InMemoryCheckpointStore()
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'tool step',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
      ]),
      tools: tools(),
      model: 'fake-model',
    })

    await expect(
      agent.run({
        userMessage: 'go',
        sessionId: 'dur-error',
        checkpointStore: store,
        maxIterations: 1,
      }),
    ).rejects.toThrow(/exceeded maximum iterations/)
    const list = await store.list('dur-error')
    expect(outcomeCounts(list)).toEqual({ inProgress: 1, success: 0, error: 1 })
  })

  it('treats every checkpoint save as best-effort', async () => {
    const store = new InMemoryCheckpointStore()
    const save = vi.spyOn(store, 'save').mockRejectedValue(new Error('store is broken'))
    const result = await createAgent({
      provider: new FakeProvider(twoStepScript()),
      tools: tools(),
      model: 'fake-model',
    }).run({ userMessage: 'go', checkpointStore: store })

    expect(result.finalMessage.content).toBe('done')
    expect(save).toHaveBeenCalledTimes(3)
  })

  it('preserves middleware order before the step checkpoint is saved', async () => {
    const order: string[] = []
    const middleware: AgentMiddleware = {
      name: 'durable-order',
      afterModel: async (message) => {
        order.push(`middleware:${message.content}`)
        return { ...message, content: `${message.content}:processed` }
      },
    }
    const store = new InMemoryCheckpointStore()
    const save = vi.spyOn(store, 'save').mockImplementation(async (checkpoint) => {
      const lastAssistant = [...checkpoint.messages]
        .reverse()
        .find((message) => message.role === 'assistant')
      order.push(`checkpoint:${lastAssistant?.content ?? ''}`)
      return checkpoint
    })
    await createAgent({
      provider: new FakeProvider([
        { message: { role: 'assistant', content: 'done', toolCalls: [] } },
      ]),
      tools: new ToolRegistry(),
      model: 'fake-model',
      middleware: [middleware],
    }).run({ userMessage: 'go', sessionId: 'dur-order', checkpointStore: store })

    expect(order).toEqual([
      'middleware:done',
      'checkpoint:done:processed',
      'checkpoint:done:processed',
    ])
    const list = await store.list('dur-order')
    expect(
      list.every((item) => {
        const last = item.messages.at(-1)
        return last?.role === 'assistant' && last.content === 'done:processed'
      }),
    ).toBe(true)
  })
})

describe('Agent.streamRun durable parity', () => {
  it('persists in-progress and success outcomes for streamed runs', async () => {
    const store = new InMemoryCheckpointStore()
    const agent = createAgent({
      provider: new FakeProvider([
        { message: { role: 'assistant', content: 'streamed', toolCalls: [] } },
      ]),
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    const events: string[] = []
    for await (const event of agent.streamRun({
      userMessage: 'go',
      sessionId: 'dur-stream',
      checkpointStore: store,
    })) {
      events.push(event.type)
    }

    expect(events.at(-1)).toBe('run:end')
    expect(outcomeCounts(await store.list('dur-stream'))).toEqual({
      inProgress: 0,
      success: 1,
      error: 0,
    })
  })
})

describe('AgentCheckpoint outcome schema', () => {
  it('accepts all outcomes and remains backward compatible when omitted', () => {
    const base = {
      id: 'x',
      sessionId: 's',
      messages: [],
      iterations: 0,
      createdAt: 0,
    }
    expect(AgentCheckpointSchema.safeParse(base).success).toBe(true)
    for (const outcome of ['in_progress', 'success', 'error'] as const) {
      expect(AgentCheckpointSchema.safeParse({ ...base, outcome }).success).toBe(true)
    }
    expect(AgentCheckpointSchema.safeParse({ ...base, outcome: 'paused' }).success).toBe(false)
  })
})
