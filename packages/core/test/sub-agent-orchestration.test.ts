import { describe, expect, it } from 'vitest'
import {
  PARALLEL_DEFAULT_TIMEOUT_MS,
  createParallelSubAgent,
  createSequentialSubAgent,
} from '../src/agent/sub-agent-orchestration.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

const spec = (name: string) => ({
  name,
  description: `${name} agent`,
  systemPrompt: 'You respond.',
})

describe('SequentialSubAgent', () => {
  it('runs tasks in order and returns one result per task', async () => {
    const parent = {
      provider: new FakeProvider([
        { message: { role: 'assistant', content: 'a1', toolCalls: [] } },
        { message: { role: 'assistant', content: 'a2', toolCalls: [] } },
        { message: { role: 'assistant', content: 'a3', toolCalls: [] } },
      ]),
      tools: new ToolRegistry(),
    }

    const seq = createSequentialSubAgent({
      parent,
      tasks: [
        { spec: spec('one'), prompt: 'p1' },
        { spec: spec('two'), prompt: 'p2' },
        { spec: spec('three'), prompt: 'p3' },
      ],
    })

    const results = await seq.run()

    expect(results).toHaveLength(3)
    expect(results[0]?.result.finalMessage.content).toBe('a1')
    expect(results[1]?.result.finalMessage.content).toBe('a2')
    expect(results[2]?.result.finalMessage.content).toBe('a3')
  })

  it('exposes id "sequential"', () => {
    const seq = createSequentialSubAgent({
      parent: { provider: new FakeProvider([]), tools: new ToolRegistry() },
      tasks: [],
    })
    expect(seq.id).toBe('sequential')
  })

  it('emits one event per task via stream()', async () => {
    const parent = {
      provider: new FakeProvider([
        { message: { role: 'assistant', content: 's1', toolCalls: [] } },
        { message: { role: 'assistant', content: 's2', toolCalls: [] } },
      ]),
      tools: new ToolRegistry(),
    }
    const seq = createSequentialSubAgent({
      parent,
      tasks: [
        { spec: spec('a'), prompt: 'p1' },
        { spec: spec('b'), prompt: 'p2' },
      ],
    })
    const events = []
    for await (const ev of seq.stream()) {
      events.push(ev)
    }
    expect(events).toHaveLength(2)
    expect(events[0]?.result.finalMessage.content).toBe('s1')
    expect(events[1]?.result.finalMessage.content).toBe('s2')
  })
})

describe('ParallelSubAgent', () => {
  it('runs tasks concurrently and returns results in input order', async () => {
    const parent = {
      provider: new FakeProvider([
        { message: { role: 'assistant', content: 'p1', toolCalls: [] } },
        { message: { role: 'assistant', content: 'p2', toolCalls: [] } },
        { message: { role: 'assistant', content: 'p3', toolCalls: [] } },
      ]),
      tools: new ToolRegistry(),
    }
    const par = createParallelSubAgent({
      parent,
      tasks: [
        { spec: spec('one'), prompt: 'p1' },
        { spec: spec('two'), prompt: 'p2' },
        { spec: spec('three'), prompt: 'p3' },
      ],
    })
    const results = await par.run()
    expect(results.map((r) => r.result.finalMessage.content)).toEqual(['p1', 'p2', 'p3'])
  })

  it('exposes id "parallel"', () => {
    const par = createParallelSubAgent({
      parent: { provider: new FakeProvider([]), tools: new ToolRegistry() },
      tasks: [],
    })
    expect(par.id).toBe('parallel')
  })

  it('throws when the wall-clock budget is exceeded', async () => {
    // Provider that hangs forever: a Promise that never resolves.
    let resolveProvider: ((value: unknown) => void) | undefined
    const hangingProvider = {
      id: 'hanging',
      capabilities: {
        streaming: false,
        embeddings: false,
        toolUse: false,
        vision: false,
        reasoning: false,
        promptCaching: false,
        structuredOutput: false,
        maxContextTokens: 1000,
      },
      chat: () =>
        new Promise<{ content: string }>((resolve) => {
          resolveProvider = resolve as (v: unknown) => void
        }),
      stream: () =>
        new Promise<{ content: string }>(() => {
          /* never resolves */
        }),
    }
    const par = createParallelSubAgent(
      {
        parent: {
          provider: hangingProvider as never,
          tools: new ToolRegistry(),
        },
        tasks: [{ spec: spec('a'), prompt: 'p' }],
      },
      10,
    )

    const promise = par.run()
    expect(PARALLEL_DEFAULT_TIMEOUT_MS).toBe(60_000)
    await expect(promise).rejects.toThrow(/timeout/)
    // Resolve the hanging provider so the test does not leak the timer.
    if (resolveProvider) {
      resolveProvider({ content: 'late' })
    }
  })
})
