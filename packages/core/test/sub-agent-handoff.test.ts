import { describe, expect, it } from 'vitest'
import {
  HANDOFF_TOOL_NAME,
  HandoffPayloadSchema,
  SupervisorDecisionSchema,
  SupervisorDecisionToolInputSchema,
  createHandoffSubAgent,
  createSupervisorSubAgent,
  extractHandoff,
} from '../src/agent/sub-agent-handoff.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

const spec = (name: string) => ({
  name,
  description: `${name} agent`,
  systemPrompt: 'You respond.',
})

describe('HandoffSubAgent', () => {
  it('emits a handoff tool call that extractHandoff recognizes', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'passing control',
          toolCalls: [
            {
              id: 'h1',
              name: HANDOFF_TOOL_NAME,
              arguments: { to: 'parent', reason: 'task done' },
            },
          ],
        },
      },
      // Step 2: model emits no tool calls, so the loop terminates.
      // The handoff tool call from step 1 is still recorded in the
      // message history, which is what extractHandoff scans.
      { message: { role: 'assistant', content: 'finished', toolCalls: [] } },
    ])
    const handoff = createHandoffSubAgent({
      parent: { provider, tools: new ToolRegistry() },
      spec: spec('worker'),
      prompt: 'do work',
    })
    const result = await handoff.run()
    const handoffPayload = extractHandoff(result.result)
    expect(handoffPayload).toEqual({ to: 'parent', reason: 'task done' })
  })

  it('exposes id prefixed with handoff:', () => {
    const provider = new FakeProvider([])
    const handoff = createHandoffSubAgent({
      parent: { provider, tools: new ToolRegistry() },
      spec: spec('worker'),
      prompt: 'do work',
    })
    expect(handoff.id).toBe('handoff:worker')
  })
})

describe('HandoffPayloadSchema', () => {
  it('accepts a valid payload', () => {
    expect(
      HandoffPayloadSchema.safeParse({ to: 'parent', reason: 'done' }).success,
    ).toBe(true)
  })
  it('rejects missing fields', () => {
    expect(HandoffPayloadSchema.safeParse({ to: 'parent' }).success).toBe(false)
  })
})

describe('SupervisorDecisionSchema / Tool input schema', () => {
  it('accepts valid decisions', () => {
    expect(SupervisorDecisionSchema.safeParse('continue').success).toBe(true)
    expect(SupervisorDecisionSchema.safeParse('redo').success).toBe(true)
    expect(SupervisorDecisionSchema.safeParse('abort').success).toBe(true)
    expect(SupervisorDecisionSchema.safeParse('maybe').success).toBe(false)
  })
  it('parses tool input JSON', () => {
    const r = SupervisorDecisionToolInputSchema.safeParse({
      decision: 'abort',
      reason: 'too costly',
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.decision).toBe('abort')
      expect(r.data.reason).toBe('too costly')
    }
  })
})

describe('SupervisorSubAgent', () => {
  it('runs all tasks when the judge decides continue', async () => {
    // Provider scripts: 1 task1 sub-agent, 1 task2 sub-agent, 1 judge (continue),
    // 1 final message synthesis is internal.
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b', toolCalls: [] } },
    ])
    const sup = createSupervisorSubAgent({
      parent: { provider, tools: new ToolRegistry() },
      judgeProvider: {
        id: 'judge',
        chat: () =>
          Promise.resolve({
            message: { role: 'assistant', content: '{"decision":"continue","reason":"ok"}', toolCalls: [] },
            latencyMs: 0,
          }),
      } as never,
      tasks: [
        { spec: spec('one'), prompt: 'p1' },
        { spec: spec('two'), prompt: 'p2' },
      ],
    })
    const result = await sup.run()
    expect(result.iterations).toBeGreaterThan(0)
  })

  it('aborts the chain when the judge returns abort', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a', toolCalls: [] } },
    ])
    const judgeProvider = {
      id: 'judge',
      chat: () =>
        Promise.resolve({
          message: { role: 'assistant', content: '{"decision":"abort","reason":"stop"}', toolCalls: [] },
          latencyMs: 0,
        }),
    } as never
    const sup = createSupervisorSubAgent({
      parent: { provider, tools: new ToolRegistry() },
      judgeProvider,
      tasks: [
        { spec: spec('one'), prompt: 'p1' },
        { spec: spec('two'), prompt: 'p2' },
      ],
    })
    const result = await sup.run()
    // Only the first task ran before abort; result is the first sub-agent's.
    expect(result.iterations).toBeGreaterThan(0)
  })

  it('exposes id "supervisor"', () => {
    const sup = createSupervisorSubAgent({
      parent: { provider: new FakeProvider([]), tools: new ToolRegistry() },
      tasks: [],
    })
    expect(sup.id).toBe('supervisor')
  })
})
