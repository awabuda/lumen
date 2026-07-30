/**
 * P32.3 unit tests for `InMemoryCheckpointStore.listSessions`
 * and `InMemoryCheckpointStore.deleteSession`.
 *
 * Mirrors the SQLite-side tests in `@lumen/memory/.../checkpoint-sessions.test.ts`
 * — the SQLite tests pin the SQL aggregation behaviour, while
 * this file pins the in-memory aggregation behaviour that
 * downstream tests rely on.
 */

import type { AgentCheckpoint } from '@lumen/core'
import { InMemoryCheckpointStore } from '@lumen/core'
import { describe, expect, it } from 'vitest'

const cp = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  id: 's1-1',
  sessionId: 's1',
  iterations: 1,
  createdAt: 1_000,
  outcome: 'in_progress',
  messages: [{ role: 'user', content: 'go' }],
  ...overrides,
})

describe('InMemoryCheckpointStore.listSessions', () => {
  it('returns an empty list when there are no checkpoints', async () => {
    expect(await new InMemoryCheckpointStore().listSessions()).toEqual([])
  })

  it('groups by sessionId and sorts newest first by lastCreatedAt', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(cp({ id: 'a-1', sessionId: 'alpha', createdAt: 1_000 }))
    await store.save(cp({ id: 'a-2', sessionId: 'alpha', createdAt: 5_000 }))
    await store.save(cp({ id: 'b-1', sessionId: 'bravo', createdAt: 3_000 }))
    const summaries = await store.listSessions()
    expect(summaries.map((s) => s.sessionId)).toEqual(['alpha', 'bravo'])
    expect(summaries[0]?.lastCreatedAt).toBe(5_000)
    expect(summaries[0]?.checkpointCount).toBe(2)
    expect(summaries[1]?.checkpointCount).toBe(1)
  })

  it('limit caps the result', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(cp({ id: 'a', sessionId: 'a', createdAt: 100 }))
    await store.save(cp({ id: 'b', sessionId: 'b', createdAt: 200 }))
    await store.save(cp({ id: 'c', sessionId: 'c', createdAt: 300 }))
    const out = await store.listSessions({ limit: 2 })
    expect(out.map((s) => s.sessionId)).toEqual(['c', 'b'])
  })

  it('hasInProgress when any non-success/error checkpoint is present', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(cp({ id: 's-1', sessionId: 's', outcome: 'success' }))
    await store.save(cp({ id: 's-2', sessionId: 's' })) // default undefined
    const summaries = await store.listSessions()
    expect(summaries[0]?.hasInProgress).toBe(true)
  })

  it('hasInProgress false for fully settled sessions', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(cp({ id: 's-1', sessionId: 's', outcome: 'success' }))
    await store.save(cp({ id: 's-2', sessionId: 's', outcome: 'error' }))
    const summaries = await store.listSessions()
    expect(summaries[0]?.hasInProgress).toBe(false)
  })
})

describe('InMemoryCheckpointStore.deleteSession', () => {
  it('removes every checkpoint under one session', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(cp({ id: 'a-1', sessionId: 'a' }))
    await store.save(cp({ id: 'a-2', sessionId: 'a' }))
    await store.save(cp({ id: 'b-1', sessionId: 'b' }))
    expect(await store.deleteSession('a')).toBe(2)
    const summaries = await store.listSessions()
    expect(summaries.map((s) => s.sessionId)).toEqual(['b'])
  })

  it('returns 0 for an unknown sessionId', async () => {
    expect(await new InMemoryCheckpointStore().deleteSession('missing')).toBe(0)
  })

  it('does not match a session id by prefix substring', async () => {
    // Substring match would also delete `foo` when asked for
    // `foobar`; this guards that the equality is exact.
    const store = new InMemoryCheckpointStore()
    await store.save(cp({ id: 'foo-1', sessionId: 'foo' }))
    await store.save(cp({ id: 'foobar-1', sessionId: 'foobar' }))
    expect(await store.deleteSession('foo')).toBe(1)
    const summaries = await store.listSessions()
    expect(summaries.map((s) => s.sessionId)).toEqual(['foobar'])
  })
})
