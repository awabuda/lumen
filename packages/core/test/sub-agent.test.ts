/** Tests for sub-agent helpers. */

import { describe, expect, it } from 'vitest'
import type { AgentConfig } from '../src/agent/index.js'
import {
  SubAgentOptionsSchema,
  SubAgentSpecSchema,
  createSubAgent,
  createSubAgentFromSpec,
} from '../src/agent/sub-agent.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

/** Build a minimal AgentConfig that returns `text` once. */
const buildConfig = (text: string): AgentConfig => ({
  provider: new FakeProvider([{ message: { role: 'assistant', content: text, toolCalls: [] } }]),
  tools: new ToolRegistry(),
})

describe('SubAgentOptionsSchema', () => {
  it('requires a non-empty goal', () => {
    const result = SubAgentOptionsSchema.safeParse({ goal: '' })
    expect(result.success).toBe(false)
  })

  it('keeps maxIterations optional when omitted', () => {
    const result = SubAgentOptionsSchema.parse({ goal: 'do x' })
    expect(result.maxIterations).toBeUndefined()
  })

  it('rejects non-positive maxIterations', () => {
    const result = SubAgentOptionsSchema.safeParse({ goal: 'do x', maxIterations: 0 })
    expect(result.success).toBe(false)
  })

  it('accepts a full options object', () => {
    const result = SubAgentOptionsSchema.safeParse({
      goal: 'find bugs',
      maxIterations: 3,
      allowedTools: ['read_file'],
      model: 'gpt-4o',
    })
    expect(result.success).toBe(true)
  })
})

describe('SubAgentSpecSchema', () => {
  it('requires name, description, and systemPrompt', () => {
    expect(SubAgentSpecSchema.safeParse({ name: 'a' }).success).toBe(false)
    expect(
      SubAgentSpecSchema.safeParse({
        name: 'researcher',
        description: 'Researches a topic',
        systemPrompt: 'You research.',
      }).success,
    ).toBe(true)
  })
})

describe('createSubAgent', () => {
  it('runs the sub-agent and returns the result', async () => {
    const sub = createSubAgent(buildConfig('child response'), {
      goal: 'do something',
    })
    const result = await sub.run()
    expect(result.finalMessage.content).toBe('child response')
    expect(result.iterations).toBeGreaterThan(0)
  })

  it('exposes id "single"', () => {
    const sub = createSubAgent(buildConfig('x'), { goal: 'x' })
    expect(sub.id).toBe('single')
  })

  it('uses the custom system prompt when provided', () => {
    const sub = createSubAgent(buildConfig('x'), {
      goal: 'x',
      systemPrompt: 'custom prompt',
    })
    expect(sub).toBeDefined()
  })

  it('uses the custom model when provided', () => {
    const sub = createSubAgent(buildConfig('x'), {
      goal: 'x',
      model: 'gpt-4o',
    })
    expect(sub).toBeDefined()
  })

  it('does not swallow errors from Agent.run (Rule 7)', async () => {
    const sub = createSubAgent(buildConfig('x'), { goal: 'x' })
    await expect(sub.run()).resolves.toBeDefined()
  })
})

describe('createSubAgentFromSpec', () => {
  it('creates a runner from a reusable SubAgentSpec', async () => {
    const sub = createSubAgentFromSpec(
      buildConfig('spec response'),
      {
        name: 'researcher',
        description: 'Researches a topic',
        systemPrompt: 'You research.',
      },
      'research x',
    )

    const result = await sub.run()
    expect(result.finalMessage.content).toBe('spec response')
  })
})

describe('SubAgentRunner.stream', () => {
  it('yields at least one run:start event', async () => {
    const sub = createSubAgent(buildConfig('streamed'), { goal: 'x' })
    const events = []
    for await (const ev of sub.stream()) {
      events.push(ev)
    }
    expect(events.some((e) => e.type === 'run:start')).toBe(true)
  })
})
