import { describe, expect, it } from 'vitest'
import { Agent } from '../src/agent/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'
import { EchoTool } from './fake-tools.js'
import { FakeMemoryStore } from './fake-memory.js'
import { AbortError, MaxIterationsExceededError } from '../src/errors/index.js'

describe('Agent.run', () => {
  it('returns the final assistant message when no tools are called', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'hello back', toolCalls: [] } },
    ])
    const agent = new Agent({ provider, tools: new ToolRegistry() })
    const result = await agent.run({ userMessage: 'hi' })
    expect(result.finalMessage.content).toBe('hello back')
    expect(result.iterations).toBe(1)
  })

  it('dispatches a tool call and feeds the result back into the loop', async () => {
    const provider = new FakeProvider([
      // Step 1: ask for the echo tool
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'ping' } }],
        },
      },
      // Step 2: final answer
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const tools = new ToolRegistry().register(new EchoTool())
    const agent = new Agent({ provider, tools })
    const result = await agent.run({ userMessage: 'echo please' })
    expect(result.iterations).toBe(2)
    expect(result.finalMessage.content).toBe('done')
    // The second provider call should include the tool result
    expect(provider.calls.length).toBe(2)
    const secondCall = provider.calls[1]!
    const toolMessage = secondCall.messages.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
  })

  it('handles a missing tool gracefully (returns error result, not crash)', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'nonexistent', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'recovered', toolCalls: [] } },
    ])
    const agent = new Agent({ provider, tools: new ToolRegistry() })
    const result = await agent.run({ userMessage: 'call a missing tool' })
    expect(result.finalMessage.content).toBe('recovered')
  })

  it('throws MaxIterationsExceededError when loop never terminates', async () => {
    // Each call requests the same tool that doesn't exist — infinite loop,
    // will hit the cap.
    const provider = new FakeProvider(
      Array.from({ length: 60 }, () => ({
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c', name: 'nonexistent', arguments: {} }],
        },
      })),
    )
    const agent = new Agent({ provider, tools: new ToolRegistry(), model: 'fake-model' })
    await expect(agent.run({ userMessage: 'loop', maxIterations: 5 })).rejects.toBeInstanceOf(
      MaxIterationsExceededError,
    )
  })

  it('throws AbortError when the signal is pre-aborted', async () => {
    const provider = new FakeProvider([])
    const agent = new Agent({ provider, tools: new ToolRegistry() })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(agent.run({ userMessage: 'hi', signal: ctrl.signal })).rejects.toBeInstanceOf(
      AbortError,
    )
  })

  it('persists messages to the memory store when one is provided', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'ack', toolCalls: [] } },
    ])
    const memory = new FakeMemoryStore()
    await memory.init()
    const agent = new Agent({ provider, tools: new ToolRegistry(), memory })
    const result = await agent.run({ userMessage: 'remember me' })
    const persisted = await memory.getSessionMessages(result.sessionId)
    // system + user + assistant = 3
    expect(persisted.length).toBe(3)
    expect(persisted[1]!.content).toBe('remember me')
    expect(persisted[2]!.content).toBe('ack')
  })
})
