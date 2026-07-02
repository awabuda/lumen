import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/factory.js'
import { createReflectionMiddleware } from '../src/agent/middleware/reflection.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeMemoryStore } from './fake-memory.js'
import { FakeProvider } from './fake-provider.js'

const providerWith = (content: string): FakeProvider =>
  new FakeProvider([{ message: { role: 'assistant', content, toolCalls: [] } }])

describe('ReflectionMiddleware', () => {
  it('inline mode appends a confidence token to assistant output', async () => {
    const agent = createAgent({
      provider: providerWith('hello'),
      tools: new ToolRegistry(),
      middleware: [createReflectionMiddleware({ inline: true, runEnd: 'off' })],
    })

    const result = await agent.run({ userMessage: 'hi' })

    expect(result.finalMessage.content).toMatch(/hello \[confidence: 0\.\d{2}\]/)
  })

  it('can disable inline reflection', async () => {
    const agent = createAgent({
      provider: providerWith('hello'),
      tools: new ToolRegistry(),
      middleware: [createReflectionMiddleware({ inline: false, runEnd: 'off' })],
    })

    const result = await agent.run({ userMessage: 'hi' })

    expect(result.finalMessage.content).toBe('hello')
  })

  it('run-end reflection writes a reflection record to memory', async () => {
    const memory = new FakeMemoryStore()
    await memory.init()
    const agent = createAgent({
      provider: providerWith('final'),
      tools: new ToolRegistry(),
      memory,
      middleware: [createReflectionMiddleware({ inline: false, runEnd: 'rule', memory })],
    })

    await agent.run({ userMessage: 'remember run' })

    const records = await memory.search({ kind: 'reflection' })
    expect(records).toHaveLength(1)
    expect(records[0]?.record.content).toContain('Reflected on')
    expect(records[0]?.record.trust).toBe(0.5)
  })

  it('step-level reflection updates state every configured interval without changing output', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'one', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [createReflectionMiddleware({ inline: false, stepInterval: 1, runEnd: 'off' })],
    })

    const result = await agent.run({ userMessage: 'hi' })

    expect(result.finalMessage.content).toBe('one')
  })
})
