/**
 * P60 — sliding-window hydrate cap on
 * `Agent.hydrateMessagesFromSession`. The
 * pre-P60 limit was 1000, which on long-lived
 * sessions let old turns drown out the user's
 * actual current input (the "答非所问 /
 * 这是第一条消息" symptom on
 * `chat-lo0y9LBpGF4` with 814 prior rows).
 *
 * The cap lives in `Agent.MAX_HYDRATE_MESSAGES`
 * and is enforced at the `getSessionMessages`
 * call site, NOT inside the memory store, so the
 * store surface stays single-purpose (the
 * existing P57/P58 tests still pass with
 * `limit: 1000`).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { Agent, MAX_HYDRATE_MESSAGES } from '../src/agent/index.js'
import { ToolRegistry } from '../src/tools/index.js'

import { FakeMemoryStore } from './fake-memory.js'
import { FakeProvider } from './fake-provider.js'

let memory: FakeMemoryStore
let provider: FakeProvider

beforeEach(() => {
  memory = new FakeMemoryStore()
})

const seed = async (n: number): Promise<string> => {
  await memory.init()
  const sessionId = `s-${n}`
  await memory.createSession({ id: sessionId, title: 'p60' })
  for (let i = 0; i < n; i++) {
    await memory.appendMessage({
      sessionId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    })
  }
  return sessionId
}

describe('P60 — hydrate sliding-window cap', () => {
  it('exports MAX_HYDRATE_MESSAGES as a positive integer', () => {
    expect(typeof MAX_HYDRATE_MESSAGES).toBe('number')
    expect(MAX_HYDRATE_MESSAGES).toBeGreaterThan(0)
  })

  it('caps the history the model sees at MAX_HYDRATE_MESSAGES rows', async () => {
    // Seed 50 prior turns (way above the cap).
    const sessionId = await seed(50)
    provider = new FakeProvider([
      {
        message: { role: 'assistant', content: 'stub reply', toolCalls: [] },
      },
    ])
    const agent = new Agent({ provider, tools: new ToolRegistry(), memory })
    await agent.run({
      sessionId,
      userMessage: 'what did I just ask?',
    })
    // The provider received exactly one chat call. Its
    // `messages` payload is the hydrated history +
    // the new user message at the moment of the call.
    expect(provider.calls.length).toBe(1)
    const sent = provider.calls[0]?.messages ?? []
    // 50 prior + 1 new user = 51 writes, but the cap
    // limits the chat-payload to MAX_HYDRATE_MESSAGES +
    // the new user row.
    expect(sent.length).toBeLessThanOrEqual(MAX_HYDRATE_MESSAGES + 1)
    // The new user message is the LAST one the model
    // sees — that's the whole point of the cap.
    expect(sent.at(-1)?.role).toBe('user')
    expect(sent.at(-1)?.content).toBe('what did I just ask?')
    // The oldest prior turn ("turn-0") is dropped.
    expect(sent.some((m) => m.content === 'turn-0')).toBe(false)
    // The most-recent prior turn is the row just
    // before the new user message — it lands in the
    // window.
    expect(sent.some((m) => m.content === 'turn-49')).toBe(true)
  })

  it('does not cap when the prior history is already under the cap', async () => {
    const sessionId = await seed(3)
    provider = new FakeProvider([
      {
        message: { role: 'assistant', content: 'ack', toolCalls: [] },
      },
    ])
    const agent = new Agent({ provider, tools: new ToolRegistry(), memory })
    await agent.run({
      sessionId,
      userMessage: 'hello',
    })
    const sent = provider.calls[0]?.messages ?? []
    // 3 prior + 1 new user = 4 rows (no truncation).
    expect(sent.length).toBe(4)
    expect(sent.map((m) => m.content)).toEqual(['turn-0', 'turn-1', 'turn-2', 'hello'])
  })

  it('returns the fresh-start path when the memory store has no prior rows', async () => {
    await memory.init()
    await memory.createSession({ id: 'empty-session', title: 'empty' })
    provider = new FakeProvider([
      {
        message: { role: 'assistant', content: 'ack', toolCalls: [] },
      },
    ])
    const agent = new Agent({ provider, tools: new ToolRegistry(), memory })
    await agent.run({
      sessionId: 'empty-session',
      userMessage: 'first message',
    })
    const sent = provider.calls[0]?.messages ?? []
    // No prior rows → hydrate returns undefined →
    // default fresh-start: [system, user].
    expect(sent.length).toBe(2)
    expect(sent[0]?.role).toBe('system')
    expect(sent[1]?.role).toBe('user')
    expect(sent[1]?.content).toBe('first message')
  })
})