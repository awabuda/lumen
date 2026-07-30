/**
 * P32.3 unit tests for `SqliteCheckpointStore.listSessions` and
 * `deleteSession`.
 *
 * The slash command `/sessions` is the user-visible surface for
 * `listSessions`, and `/sessions delete <id>` calls `deleteSession`.
 * Both methods are new on `BaseCheckpointStore` in P32.3 — this
 * file pins down the SQLite side; the InMemory implementation is
 * covered by the equivalent block in `packages/core/test/...` once
 * the tests land there (kept here next to the SQLite-specific SQL
 * because that is what the test is really exercising).
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentCheckpoint } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteCheckpointStore } from '../src/sqlite-checkpoint-store.js'

let tmpDir: string
let dbPath: string
let store: SqliteCheckpointStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-checkpoint-sessions-'))
  dbPath = path.join(tmpDir, 'checkpoints.db')
  store = new SqliteCheckpointStore({ path: dbPath })
})

afterEach(async () => {
  await store.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const cp = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  id: 's1-1',
  sessionId: 's1',
  iterations: 1,
  createdAt: 1_000,
  outcome: 'in_progress',
  messages: [{ role: 'user', content: 'go' }],
  ...overrides,
})

describe('SqliteCheckpointStore.listSessions', () => {
  it('returns an empty list when there are no checkpoints', async () => {
    expect(await store.listSessions()).toEqual([])
  })

  it('groups checkpoints by sessionId with last-update ordering', async () => {
    await store.save(cp({ id: 'a-1', sessionId: 'alpha', createdAt: 1_000 }))
    await store.save(cp({ id: 'a-2', sessionId: 'alpha', createdAt: 5_000 }))
    await store.save(cp({ id: 'b-1', sessionId: 'bravo', createdAt: 3_000 }))
    const summaries = await store.listSessions()
    expect(summaries).toHaveLength(2)
    expect(summaries[0]?.sessionId).toBe('alpha')
    expect(summaries[0]?.lastCreatedAt).toBe(5_000)
    expect(summaries[0]?.checkpointCount).toBe(2)
    expect(summaries[1]?.sessionId).toBe('bravo')
    expect(summaries[1]?.lastCreatedAt).toBe(3_000)
    expect(summaries[1]?.checkpointCount).toBe(1)
  })

  it('marks hasInProgress when any checkpoint is not success/error', async () => {
    await store.save(cp({ id: 's-1', sessionId: 's', outcome: 'success' }))
    await store.save(cp({ id: 's-2', sessionId: 's', outcome: 'in_progress' }))
    const summaries = await store.listSessions()
    expect(summaries[0]?.hasInProgress).toBe(true)
  })

  it('marks hasInProgress false when all checkpoints are success or error', async () => {
    await store.save(cp({ id: 's-1', sessionId: 's', outcome: 'success' }))
    await store.save(cp({ id: 's-2', sessionId: 's', outcome: 'error' }))
    const summaries = await store.listSessions()
    expect(summaries[0]?.hasInProgress).toBe(false)
  })

  it('respects an explicit limit, dropping older sessions', async () => {
    await store.save(cp({ id: 'a', sessionId: 'a', createdAt: 100 }))
    await store.save(cp({ id: 'b', sessionId: 'b', createdAt: 200 }))
    await store.save(cp({ id: 'c', sessionId: 'c', createdAt: 300 }))
    const limited = await store.listSessions({ limit: 2 })
    expect(limited.map((s) => s.sessionId)).toEqual(['c', 'b'])
  })
})

describe('SqliteCheckpointStore.deleteSession', () => {
  it('removes every checkpoint for one session and returns the count', async () => {
    await store.save(cp({ id: 'a-1', sessionId: 'a' }))
    await store.save(cp({ id: 'a-2', sessionId: 'a' }))
    await store.save(cp({ id: 'b-1', sessionId: 'b' }))
    const removed = await store.deleteSession('a')
    expect(removed).toBe(2)
    const remaining = await store.listSessions()
    expect(remaining.map((s) => s.sessionId)).toEqual(['b'])
  })

  it('returns 0 when the session has no checkpoints', async () => {
    expect(await store.deleteSession('nope')).toBe(0)
  })

  it('does not affect a session id that shares a prefix with another', async () => {
    // Defensive: substring matching would be a footgun. The
    // SQL is `WHERE session_id = ?` so an exact match is the
    // only thing that fires.
    await store.save(cp({ id: 'foo-1', sessionId: 'foo' }))
    await store.save(cp({ id: 'foobar-1', sessionId: 'foobar' }))
    await store.deleteSession('foo')
    const summaries = await store.listSessions()
    expect(summaries.map((s) => s.sessionId)).toEqual(['foobar'])
  })
})
