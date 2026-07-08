/** P20.1 e2e: HITL interrupt middleware + checkpoint auto-save. */

import { describe, expect, it } from 'vitest'
import {
  Agent,
  createAgent,
  createInterruptMiddleware,
  InMemoryCheckpointStore,
  ToolRegistry,
} from '../src/index.js'
import { FakeProvider } from './fake-provider.js'

describe('createInterruptMiddleware', () => {
  it('throws when no rule is configured', () => {
    expect(() => createInterruptMiddleware({})).toThrow()
  })

  it('aborts when a configured tool name is about to dispatch', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 't1', name: 'write_file', arguments: { path: '/x', content: 'y' } },
          ],
        },
      },
      { message: { role: 'assistant', content: 'after', toolCalls: [] } },
    ])
    const store = new InMemoryCheckpointStore()
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [createInterruptMiddleware({ toolNames: ['write_file'] })],
    })
    // Agent.run wraps the AbortError in a MiddlewareError;
    // we recover the original via .cause.
    let caught: unknown
    try {
      await agent.run({
        userMessage: 'go',
        sessionId: 'hitl-tool',
        checkpointStore: store,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    const cause = (caught as { cause?: { message?: string } }).cause
    expect(cause?.message).toMatch(/write_file/)
    const list = await store.list('hitl-tool')
    expect(list).toHaveLength(1)
  })

  it('does NOT abort when a tool name is not in the list', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'plain', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [createInterruptMiddleware({ toolNames: ['write_file'] })],
    })
    const result = await agent.run({ userMessage: 'go' })
    expect(result.finalMessage.content).toBe('plain')
  })

  it('aborts when iteration count reaches maxIterations', async () => {
    // The default iteration step is 1 — so maxIterations=1
    // fires on the very first model call, before any tool
    // dispatch can happen. We use a single scripted response
    // and assert the run throws with the maxIterations tag.
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'never seen', toolCalls: [] } },
    ])
    const store = new InMemoryCheckpointStore()
    // Use createAgent (not `new Agent`) so the middleware
    // option is actually attached to the agent instance.
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      model: 'fake-model',
      middleware: [createInterruptMiddleware({ maxIterations: 1 })],
    })
    let caught: unknown
    try {
      await agent.run({
        userMessage: 'go',
        sessionId: 'hitl-iter',
        checkpointStore: store,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeDefined()
    const cause = (caught as { cause?: { message?: string } }).cause
    expect(cause?.message).toMatch(/maxIterations/)
    const list = await store.list('hitl-iter')
    expect(list).toHaveLength(1)
  })

  it('exposes name "interrupt"', () => {
    const m = createInterruptMiddleware({ maxIterations: 5 })
    expect(m.name).toBe('interrupt')
  })

  it('rejects a non-positive maxIterations', () => {
    expect(() => createInterruptMiddleware({ maxIterations: 0 })).toThrow()
    expect(() => createInterruptMiddleware({ maxIterations: -1 })).toThrow()
  })
})
