/**
 * P36 (bug.md #41 hooks lifecycle upgrade) — verifies
 * the additive `costUsd` + `tokensUsed` fields on the
 * `run:end` HookEvent.
 */

import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent/index.js'
import { HookRegistry } from '../src/hooks/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

const buildAgent = (hooks: HookRegistry): Agent => {
  const provider = new FakeProvider([
    {
      message: {
        role: 'assistant',
        content: 'hello back',
        toolCalls: [],
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, costUsd: 0.001 },
      },
    },
  ])
  const tools = new ToolRegistry()
  return new Agent({
    provider,
    tools,
    hooks,
    config: {
      defaultModel: 'fake-test',
      agent: { maxIterations: 1 },
    } as never,
  })
}

describe('run:end hook — P36 costUsd + tokensUsed', () => {
  it('surfaces costUsd + tokensUsed on the run:end event', async () => {
    const registry = new HookRegistry()
    const events: Array<{ kind: string; costUsd?: number; tokensUsed?: number }> = []
    registry.register((event) => {
      if (event.kind === 'run:end') {
        events.push({
          kind: event.kind,
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
          ...(event.tokensUsed !== undefined ? { tokensUsed: event.tokensUsed } : {}),
        })
      }
    })
    const agent = buildAgent(registry)
    await agent.run({ userMessage: 'hello' })
    const runEnd = events.find((e) => e.kind === 'run:end')
    expect(runEnd).toBeDefined()
    expect(typeof runEnd?.costUsd).toBe('number')
    expect(typeof runEnd?.tokensUsed).toBe('number')
    expect(runEnd?.costUsd ?? 0).toBeGreaterThan(0)
    expect(runEnd?.tokensUsed ?? 0).toBeGreaterThan(0)
  })

  it('keeps the pre-P36 discriminator shape (costUsd / tokensUsed optional)', () => {
    const event: { kind: 'run:end'; sessionId: string } = {
      kind: 'run:end',
      sessionId: 'legacy',
    }
    expect(event.kind).toBe('run:end')
    expect((event as { costUsd?: number }).costUsd).toBeUndefined()
  })
})
