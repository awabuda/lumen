import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
/** P21.1 auto-resume unit and SQLite integration tests. */
import { type AgentCheckpoint, InMemoryCheckpointStore } from '@lumen/core'
import { SqliteCheckpointStore } from '@lumen/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_RESUME_TTL_MS, findResumeCheckpoint } from '../src/checkpoint-resume.js'

const checkpoint = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  id: 'session-1-1',
  sessionId: 'session-1',
  messages: [{ role: 'user', content: 'go' }],
  iterations: 1,
  createdAt: 1_000,
  outcome: 'in_progress',
  ...overrides,
})

describe('findResumeCheckpoint', () => {
  it('returns the newest fresh in-progress checkpoint', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(checkpoint({ id: 'old', createdAt: 900 }))
    await store.save(checkpoint({ id: 'new', createdAt: 1_100 }))
    await store.save(checkpoint({ id: 'success', createdAt: 1_200, outcome: 'success' }))

    expect((await findResumeCheckpoint({ store, now: 1_300, ttlMs: 500 }))?.id).toBe('new')
  })

  it('treats a legacy checkpoint without outcome as in progress', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(checkpoint({ id: 'legacy', outcome: undefined }))
    expect((await findResumeCheckpoint({ store, now: 1_100 }))?.id).toBe('legacy')
  })

  it('rejects stale checkpoints and honors the default 10 minute TTL', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(checkpoint({ createdAt: 1_000 }))
    expect(
      await findResumeCheckpoint({ store, now: 1_000 + DEFAULT_RESUME_TTL_MS + 1 }),
    ).toBeUndefined()
  })

  it('returns undefined when resume is disabled', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(checkpoint())
    expect(await findResumeCheckpoint({ store, enabled: false })).toBeUndefined()
  })

  it('scopes discovery to a requested session', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save(checkpoint({ id: 'a', sessionId: 'a', createdAt: 2_000 }))
    await store.save(checkpoint({ id: 'b', sessionId: 'b', createdAt: 3_000 }))
    expect((await findResumeCheckpoint({ store, sessionId: 'a', now: 3_100 }))?.sessionId).toBe('a')
  })

  it.each([0, -1, 1.5])('rejects invalid TTL %s', async (ttlMs) => {
    await expect(
      findResumeCheckpoint({ store: new InMemoryCheckpointStore(), ttlMs }),
    ).rejects.toThrow('resumeTtlMs must be a positive integer')
  })
})

describe('SqliteCheckpointStore latestInProgress', () => {
  const dirs: string[] = []
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  })

  it('discovers a fresh checkpoint across store instances', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-resume-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'checkpoint.db')
    const writer = new SqliteCheckpointStore({ path: dbPath })
    await writer.save(checkpoint({ createdAt: 5_000 }))
    await writer.dispose()

    const reader = new SqliteCheckpointStore({ path: dbPath })
    try {
      expect((await reader.latestInProgress({ minCreatedAt: 4_000 }))?.sessionId).toBe('session-1')
    } finally {
      await reader.dispose()
    }
  })
})
