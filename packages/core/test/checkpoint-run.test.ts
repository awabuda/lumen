/** P20.4.2 e2e: Agent.run resumeFrom + auto-save on abort. */

import { describe, expect, it } from 'vitest'
import { Agent, InMemoryCheckpointStore, ToolRegistry } from '../src/index.js'
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
          toolCalls: [
            { id: 't1', name: 'unknown_tool', arguments: {} },
          ],
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
    // The store must have at least one checkpoint saved, and
    // that checkpoint's messages should include the original
    // user turn ("go") — i.e. the snapshot was taken BEFORE
    // the throw.
    const list = await store.list('test-abort')
    expect(list.length).toBe(1)
    const cp = list[0]
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
