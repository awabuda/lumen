/** Tests for the agent checkpoint module (P20.4). */

import { describe, expect, it } from 'vitest'
import type { AgentRunResult, AssistantMessage, Message } from '../src/index.js'
import {
  AgentCheckpointSchema,
  InMemoryCheckpointStore,
  checkpointFromRun,
} from '../src/agent/checkpoint.js'

const fakeResult = (overrides: Partial<AgentRunResult> = {}): AgentRunResult => {
  const messages: Message[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]
  return {
    sessionId: 's1',
    finalMessage: { role: 'assistant', content: 'done', toolCalls: [] } as AssistantMessage,
    iterations: 3,
    messages,
    ...overrides,
  }
}

describe('checkpointFromRun', () => {
  it('builds a checkpoint from a run result with no label', () => {
    const cp = checkpointFromRun(fakeResult())
    expect(cp.id).toBe('s1-3')
    expect(cp.sessionId).toBe('s1')
    expect(cp.iterations).toBe(3)
    expect(cp.messages).toHaveLength(2)
    expect(cp.label).toBeUndefined()
  })

  it('attaches a label when provided', () => {
    const cp = checkpointFromRun(fakeResult(), 'after-step-3')
    expect(cp.label).toBe('after-step-3')
  })

  it('validates the produced checkpoint against the schema', () => {
    const cp = checkpointFromRun(fakeResult())
    expect(() => AgentCheckpointSchema.parse(cp)).not.toThrow()
  })
})

describe('InMemoryCheckpointStore', () => {
  it('saves and retrieves a checkpoint by id', async () => {
    const store = new InMemoryCheckpointStore()
    const cp = checkpointFromRun(fakeResult())
    await store.save(cp)
    const got = await store.get(cp.id)
    expect(got?.id).toBe(cp.id)
  })

  it('lists checkpoints for a session, newest first', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save({
      ...checkpointFromRun(fakeResult({ iterations: 1 })),
      createdAt: 100,
    })
    await store.save({
      ...checkpointFromRun(fakeResult({ iterations: 2 })),
      createdAt: 200,
    })
    const list = await store.list('s1')
    expect(list).toHaveLength(2)
    expect(list[0]?.iterations).toBe(2)
    expect(list[1]?.iterations).toBe(1)
  })

  it('returns an empty list for an unknown session', async () => {
    const store = new InMemoryCheckpointStore()
    const list = await store.list('no-such-session')
    expect(list).toEqual([])
  })

  it('returns true on delete when the checkpoint existed', async () => {
    const store = new InMemoryCheckpointStore()
    const cp = checkpointFromRun(fakeResult())
    await store.save(cp)
    expect(await store.delete(cp.id)).toBe(true)
    expect(await store.get(cp.id)).toBeUndefined()
  })

  it('returns false on delete when the checkpoint was missing', async () => {
    const store = new InMemoryCheckpointStore()
    expect(await store.delete('nope')).toBe(false)
  })

  it('exposes id "memory"', () => {
    const store = new InMemoryCheckpointStore()
    expect(store.id).toBe('memory')
  })

  it('rejects a checkpoint whose id is empty (Zod schema)', async () => {
    const store = new InMemoryCheckpointStore()
    await expect(
      store.save({
        id: '',
        sessionId: 's1',
        messages: [],
        iterations: 0,
        createdAt: 0,
      }),
    ).rejects.toThrow()
  })
})
