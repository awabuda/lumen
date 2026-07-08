/** P20.6 e2e: skill trigger middleware. */

import { describe, expect, it } from 'vitest'
import { Agent, type Message, ToolRegistry } from '../src/index.js'
import { FakeProvider } from './fake-provider.js'

describe('createSkillTriggerMiddleware', () => {
  it('prepends a system augmentation listing active skills', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const trigger = async (msg: string) => {
      if (msg.includes('git')) {
        return [
          { id: 'git-commit', name: 'git commit', description: 'make a commit' },
        ]
      }
      return []
    }
    const m = createSkillTriggerMiddleware({ trigger })
    const input: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'help me make a git commit' },
    ]
    const out = await m.beforeModel!(input, {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(out).toHaveLength(3)
    expect(out[0]?.role).toBe('system')
    const aug = out[0]
    if (aug && aug.role === 'system') {
      expect(aug.content).toContain('Active skills')
      expect(aug.content).toContain('git commit')
    }
  })

  it('passes through when the trigger returns no skills', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const trigger = async () => []
    const m = createSkillTriggerMiddleware({ trigger })
    const input: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'no trigger words' },
    ]
    const out = await m.beforeModel!(input, {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(out).toEqual(input)
  })

  it('truncates the active list to maxActive', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const trigger = async () => [
      { id: 'a', name: 'A', description: 'a' },
      { id: 'b', name: 'B', description: 'b' },
      { id: 'c', name: 'C', description: 'c' },
      { id: 'd', name: 'D', description: 'd' },
    ]
    const m = createSkillTriggerMiddleware({ trigger, maxActive: 2 })
    const out = await m.beforeModel!(
      [{ role: 'user', content: 'go' }],
      { sessionId: 's', iteration: 1, startedAt: 0, state: {}, control: { continueAfterModel: false } },
    )
    expect(out).toHaveLength(2)
    const aug = out[0]
    if (aug && aug.role === 'system') {
      expect(aug.content).toContain('A')
      expect(aug.content).toContain('B')
      expect(aug.content).not.toContain('C')
      expect(aug.content).not.toContain('D')
    }
  })

  it('passes through when there is no user message', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const trigger = async () => [{ id: 'a', name: 'A', description: 'a' }]
    const m = createSkillTriggerMiddleware({ trigger })
    const input: Message[] = [{ role: 'system', content: 'sys' }]
    const out = await m.beforeModel!(input, {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(out).toEqual(input)
  })

  it('only uses the most recent user message', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const calls: string[] = []
    const trigger = async (msg: string) => {
      calls.push(msg)
      if (msg.includes('second')) {
        return [{ id: 'second', name: 'Second', description: 'second' }]
      }
      return []
    }
    const m = createSkillTriggerMiddleware({ trigger })
    const input: Message[] = [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply', toolCalls: [] },
      { role: 'user', content: 'second message' },
    ]
    const out = await m.beforeModel!(input, {
      sessionId: 's',
      iteration: 1,
      startedAt: 0,
      state: {},
      control: { continueAfterModel: false },
    })
    expect(calls).toEqual(['second message'])
    expect(out).toHaveLength(4)
  })

  it('accepts a custom formatActive', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const trigger = async () => [{ id: 'a', name: 'A', description: 'a' }]
    const m = createSkillTriggerMiddleware({
      trigger,
      formatActive: (skills) =>
        `<<<${skills.map((s) => s.id).join(',')}>>>`,
    })
    const out = await m.beforeModel!(
      [{ role: 'user', content: 'go' }],
      { sessionId: 's', iteration: 1, startedAt: 0, state: {}, control: { continueAfterModel: false } },
    )
    const aug = out[0]
    if (aug && aug.role === 'system') {
      expect(aug.content).toBe('<<<a>>>')
    }
  })

  it('exposes name "skill-trigger"', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const m = createSkillTriggerMiddleware({ trigger: async () => [] })
    expect(m.name).toBe('skill-trigger')
  })

  it('rejects non-positive maxActive at the Zod layer', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    expect(() =>
      createSkillTriggerMiddleware({ trigger: async () => [], maxActive: 0 }),
    ).toThrow()
  })

  it('rejects a missing trigger function', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    // @ts-expect-error — testing the runtime guard
    expect(() => createSkillTriggerMiddleware({})).toThrow()
  })

  it('roundtrips through a real Agent.run (the provider sees the augmentation)', async () => {
    const { createSkillTriggerMiddleware } = await import(
      '../src/agent/middleware/skill-trigger.js'
    )
    const { createAgent } = await import('../src/index.js')
    const trigger = async (msg: string) => {
      if (msg.includes('hello')) {
        return [{ id: 'greeter', name: 'Greeter', description: 'say hi' }]
      }
      return []
    }
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'hi there', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      model: 'fake-model',
      middleware: [createSkillTriggerMiddleware({ trigger })],
    })
    const result = await agent.run({ userMessage: 'hello world' })
    expect(result.finalMessage.content).toBe('hi there')
    // The first call to the provider should have an extra
    // system message at the top (the augmentation), plus the
    // original system + user turn.
    const firstMessages = provider.calls[0]?.messages
    expect(firstMessages?.[0]?.role).toBe('system')
    const first = firstMessages?.[0]
    if (first && first.role === 'system') {
      expect(first.content).toContain('Greeter')
    }
  })
})
