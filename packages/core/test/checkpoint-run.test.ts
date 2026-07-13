/** P20.4.2 e2e: Agent.run resumeFrom + auto-save on abort. */

import { describe, expect, it } from 'vitest'
import { ProviderPool } from '../src/agent/pool.js'
import { ProviderError } from '../src/errors/index.js'
import {
  Agent,
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  InMemoryCheckpointStore,
  type ProviderCapabilities,
  type StreamEvent,
  type StreamOptions,
  ToolRegistry,
} from '../src/index.js'
import { FakeProvider } from './fake-provider.js'

describe('Agent.run checkpoint integration (P20.4.2)', () => {
  it('saves a checkpoint when the run is aborted', async () => {
    const store = new InMemoryCheckpointStore()
    // The agent emits a tool call on step 1, then attempts to
    // dispatch the unknown tool. The dispatch throws (tool not
    // found), which is the kind of failure that should trigger
    // an auto-save before the throw propagates.
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'unknown_tool', arguments: {} }],
        },
      },
    ])
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    await expect(
      agent.run({
        userMessage: 'go',
        sessionId: 'test-abort',
        checkpointStore: store,
      }),
    ).rejects.toThrow()
    // The interrupted step is persisted as in-progress, followed by an error marker.
    const list = await store.list('test-abort')
    expect(list.length).toBe(2)
    const cp = list.find((item) => item.outcome === 'error')
    expect(cp?.outcome).toBe('error')
    expect(cp?.messages.some((m) => m.role === 'user' && m.content === 'go')).toBe(true)
  })

  it('resumes from a previously saved checkpoint and skips the user-message seed', async () => {
    // Build a fake checkpoint that already contains a user turn
    // and an assistant response. The next agent.run with
    // resumeFrom should NOT prepend a fresh system + user message
    // and should pass the checkpoint's messages straight to the
    // provider.
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'previous turn' },
      { role: 'assistant', content: 'previous answer', toolCalls: [] },
    ]
    const checkpoint = {
      id: 's1-2',
      sessionId: 's1',
      messages,
      iterations: 2,
      createdAt: Date.now(),
    }
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'resumed',
          toolCalls: [],
        },
      },
    ])
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    const result = await agent.run({
      userMessage: 'this is ignored',
      resumeFrom: checkpoint,
    })
    // The provider should have seen the checkpoint's messages
    // plus the resumed assistant message — NOT a fresh system
    // + user seed. The first call's messages are exactly the
    // checkpoint's history (3 messages).
    expect(provider.calls[0]?.messages).toHaveLength(3)
    expect(result.iterations).toBe(1)
    expect(result.finalMessage.content).toBe('resumed')
    expect(result.sessionId).toBe('s1')
  })

  it('falls back to fresh system+user when no resumeFrom is provided', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'ok', toolCalls: [] } },
    ])
    const agent = new Agent({
      provider,
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    await agent.run({ userMessage: 'go' })
    // The first provider call should have 2 messages: system + user.
    expect(provider.calls[0]?.messages).toHaveLength(2)
  })
})

/**
 * P20.5 e2e: provider pool failover + checkpoint.
 *
 * The ProviderPool transparently falls back from a failing
 * primary provider to a working secondary. When fallback
 * succeeds, Agent.run never throws, so no checkpoint is
 * saved (the run completed normally). When every provider
 * in the pool exhausts its retries, Agent.run throws
 * PoolExhaustedError, which is caught by the existing
 * P20.4.2 checkpoint-on-throw path. This suite documents
 * both behaviours so the "fallback chain + auto-checkpoint"
 * P20.5 promise is verifiable in a regression.
 */
describe('Agent.run + ProviderPool checkpoint (P20.5)', () => {
  /**
   * A provider that always throws a retryable ProviderError.
   * Used to simulate a primary provider that is "down" for
   * the duration of the test.
   */
  class AlwaysFailingProvider extends BaseProvider {
    public readonly id: string
    public callCount = 0
    public constructor(id: string) {
      super()
      this.id = id
    }
    public override readonly capabilities: ProviderCapabilities = {
      streaming: false,
      embeddings: false,
      toolUse: false,
      vision: false,
      reasoning: false,
      promptCaching: false,
      structuredOutput: false,
      maxContextTokens: 8000,
    }
    public override async chat(
      _request: ChatRequest,
      _options?: StreamOptions,
    ): Promise<ChatResponse> {
      this.callCount += 1
      throw new ProviderError(`Provider '${this.id}' simulated outage`, {
        providerId: this.id,
        statusCode: 503,
        retryable: true,
      })
    }
    public override async *stream(): AsyncGenerator<StreamEvent, void, void> {
      this.callCount += 1
      yield {
        type: 'error',
        error: new ProviderError(`Provider '${this.id}' simulated outage`, {
          providerId: this.id,
          statusCode: 503,
          retryable: true,
        }),
      }
    }
  }

  it('does NOT save a checkpoint when the pool falls back successfully', async () => {
    const store = new InMemoryCheckpointStore()
    const failing = new AlwaysFailingProvider('primary')
    const working = new FakeProvider([
      { message: { role: 'assistant', content: 'fallback ok', toolCalls: [] } },
    ])
    const pool = new ProviderPool({
      providers: [
        { provider: failing, weight: 1 },
        { provider: working, weight: 1 },
      ],
    })
    const agent = new Agent({
      provider: pool,
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    const result = await agent.run({
      userMessage: 'go',
      sessionId: 'fallback-success',
      checkpointStore: store,
    })
    expect(result.finalMessage.content).toBe('fallback ok')
    expect(failing.callCount).toBeGreaterThanOrEqual(1)
    // P21 records both the completed step and the terminal success marker.
    const list = await store.list('fallback-success')
    expect(list).toHaveLength(1)
    expect(list[0]?.outcome).toBe('success')
  })

  it('saves a checkpoint when the pool exhausts every provider', async () => {
    const store = new InMemoryCheckpointStore()
    const a = new AlwaysFailingProvider('a')
    const b = new AlwaysFailingProvider('b')
    const c = new AlwaysFailingProvider('c')
    const pool = new ProviderPool({
      providers: [
        { provider: a, weight: 1 },
        { provider: b, weight: 1 },
        { provider: c, weight: 1 },
      ],
    })
    const agent = new Agent({
      provider: pool,
      tools: new ToolRegistry(),
      model: 'fake-model',
    })
    await expect(
      agent.run({
        userMessage: 'go',
        sessionId: 'pool-exhausted',
        checkpointStore: store,
      }),
    ).rejects.toThrow()
    // All three providers were tried.
    expect(a.callCount).toBeGreaterThanOrEqual(1)
    expect(b.callCount).toBeGreaterThanOrEqual(1)
    expect(c.callCount).toBeGreaterThanOrEqual(1)
    // PoolExhaustedError is caught by Agent.run's existing
    // checkpoint-on-throw path, so the store has a snapshot
    // for this session.
    const list = await store.list('pool-exhausted')
    expect(list).toHaveLength(1)
    expect(list[0]?.messages.some((m) => m.role === 'user' && m.content === 'go')).toBe(true)
  })
})
