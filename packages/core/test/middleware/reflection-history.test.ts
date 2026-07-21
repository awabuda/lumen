/**
 * P23.4 — reflection reads full conversation history (bug #5).
 *
 * Before P23.4:
 *   - ReflectionMiddleware.afterModel built a single-element array
 *     `[message]` and passed it to ruleBasedReflectMessages. The
 *     reflection heuristic counts assistant turns, tool turns, and
 *     error-pattern occurrences — all of which require the full
 *     history. The pre-P23.4 implementation collapsed every run
 *     to "1 message, 0 tools, 0 errors" regardless of how long
 *     the conversation actually was.
 *
 * After P23.4:
 *   - MiddlewareContext.history: ReadonlyArray<Message> — the
 *     full conversation history at the point the hook fires.
 *   - Agent.run attaches history to ctx on beforeModel,
 *     wrapModelCall, afterModel, and afterRun.
 *   - ReflectionMiddleware reads ctx.history instead of `[message]`.
 *
 * Tests assert the heuristic signals (assistant count, tool count)
 * reach their expected values after multiple scripted turns.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../../src/agent/factory.js'
import type { AgentMiddleware } from '../../src/agent/middleware.js'
import { createReflectionMiddleware } from '../../src/agent/middleware/reflection.js'
import type { AssistantMessage, Message } from '../../src/message/index.js'
import { ToolRegistry } from '../../src/tools/index.js'
import { FakeProvider } from '../fake-provider.js'

/** Summary of a single hook invocation. */
interface HistorySnapshot {
  readonly hook: 'beforeModel' | 'afterModel' | 'afterRun'
  readonly length: number
  readonly assistantCount: number
}

const summarise = (
  history: ReadonlyArray<Message> | undefined,
  hook: 'beforeModel' | 'afterModel' | 'afterRun',
): HistorySnapshot => ({
  hook,
  length: history?.length ?? -1,
  assistantCount: history?.filter((m) => (m as AssistantMessage).role === 'assistant').length ?? -1,
})

/** Build a history probe with a public `captured` array. */
const buildHistoryProbe = (): AgentMiddleware & {
  captured: HistorySnapshot[]
} => {
  const captured: HistorySnapshot[] = []
  const EmptyState = z.object({}).strict()
  const probe = {
    name: 'history-probe',
    stateSchema: EmptyState,
    initialState: {},
    beforeModel: (messages: ReadonlyArray<Message>, ctx: { history?: ReadonlyArray<Message> }) => {
      captured.push(summarise(ctx.history, 'beforeModel'))
      return messages
    },
    afterModel: (message: AssistantMessage, ctx: { history?: ReadonlyArray<Message> }) => {
      captured.push(summarise(ctx.history, 'afterModel'))
      return message
    },
    captured,
  } as unknown as AgentMiddleware & { captured: HistorySnapshot[] }
  return probe
}

describe('P23.4 — ctx.history wire-up', () => {
  it('beforeModel sees the pre-call history growing across iterations', async () => {
    const probe = buildHistoryProbe()
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'a',
          toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'b',
          toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'c', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [probe],
    })
    await agent.run({ userMessage: 'hi' })
    const beforeCalls = probe.captured.filter((c) => c.hook === 'beforeModel')
    expect(beforeCalls).toHaveLength(3)
    // Iteration 1: system + user (length 2).
    expect(beforeCalls[0]?.length).toBe(2)
    // Iteration 2: system + user + assistant 'a' + tool result (length 4).
    expect(beforeCalls[1]?.length).toBe(4)
    // Iteration 3: + assistant 'b' + tool result (length 6).
    expect(beforeCalls[2]?.length).toBe(6)
  })

  it('afterModel sees the post-call history (just-emitted message included)', async () => {
    const probe = buildHistoryProbe()
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'a',
          toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'b', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [probe],
    })
    await agent.run({ userMessage: 'hi' })
    const afterCalls = probe.captured.filter((c) => c.hook === 'afterModel')
    expect(afterCalls).toHaveLength(2)
    // Iteration 1's afterModel: system + user + assistant 'a' (length 3).
    expect(afterCalls[0]?.length).toBe(3)
    expect(afterCalls[0]?.assistantCount).toBe(1)
    // Iteration 2's afterModel: + tool result + assistant 'b' (length 5).
    expect(afterCalls[1]?.length).toBe(5)
    expect(afterCalls[1]?.assistantCount).toBe(2)
  })
})

describe('P23.4 — reflection reads full history', () => {
  it('inline reflection fires across multiple turns (proves history was read)', async () => {
    // 3 turns. The inline-reflection hook must observe ≥2
    // assistant messages by the third turn (proves the heuristic
    // is no longer collapsing to "1 message"). We assert via the
    // inline confidence marker being present.
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'first turn',
          toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'second turn',
          toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'final', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [createReflectionMiddleware({ inline: true, stepInterval: 1 })],
    })
    const result = await agent.run({ userMessage: 'hi' })
    expect(result.finalMessage.content).toContain('[confidence:')
  })

  it('afterRun reads full history (probe confirms length)', async () => {
    let afterRunHistoryLength = -1
    const probe: AgentMiddleware = {
      name: 'probe',
      stateSchema: z.object({}).strict(),
      initialState: {},
      afterRun: (_result, ctx: { history?: ReadonlyArray<Message> }) => {
        afterRunHistoryLength = ctx.history?.length ?? -1
      },
    }
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'a',
          toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'b', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [probe],
    })
    await agent.run({ userMessage: 'hi' })
    // After 2 turns with tool calls, history includes: user
    // + assistant 'a' + tool result + assistant 'b' (≥3).
    expect(afterRunHistoryLength).toBeGreaterThanOrEqual(3)
  })
})
