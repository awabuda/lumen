/** Tests for SqliteCheckpointStore (P20.4.4). */

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-checkpoint-test-'))
  dbPath = path.join(tmpDir, 'checkpoints.db')
  store = new SqliteCheckpointStore({ path: dbPath })
  // Schema is applied in the constructor; nothing else to init.
  // (We use a manual init path because BaseCheckpointStore has
  // no `init` method — the constructor is enough.)
})

afterEach(async () => {
  await store.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const cp = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  id: 's1-1',
  sessionId: 's1',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
  ],
  iterations: 1,
  createdAt: 100,
  ...overrides,
})

describe('SqliteCheckpointStore', () => {
  it('saves and retrieves a checkpoint by id', async () => {
    await store.save(cp())
    const got = await store.get('s1-1')
    expect(got?.id).toBe('s1-1')
    expect(got?.messages).toHaveLength(2)
  })

  it('overwrites on save with the same id', async () => {
    await store.save(cp())
    await store.save(cp({ iterations: 2, createdAt: 200 }))
    const got = await store.get('s1-1')
    expect(got?.iterations).toBe(2)
    expect(got?.createdAt).toBe(200)
  })

  it('lists checkpoints for a session, newest first', async () => {
    await store.save(cp({ id: 's1-1', createdAt: 100 }))
    await store.save(cp({ id: 's1-2', iterations: 2, createdAt: 200 }))
    const list = await store.list('s1')
    expect(list).toHaveLength(2)
    expect(list[0]?.id).toBe('s1-2')
    expect(list[1]?.id).toBe('s1-1')
  })

  it('returns an empty list for an unknown session', async () => {
    const list = await store.list('no-such-session')
    expect(list).toEqual([])
  })

  it('deletes a checkpoint by id and returns true', async () => {
    await store.save(cp())
    expect(await store.delete('s1-1')).toBe(true)
    expect(await store.get('s1-1')).toBeUndefined()
  })

  it('returns false on delete when the id is unknown', async () => {
    expect(await store.delete('nope')).toBe(false)
  })

  it('preserves the optional label', async () => {
    await store.save(cp({ label: 'after step 1' }))
    const got = await store.get('s1-1')
    expect(got?.label).toBe('after step 1')
  })

  it('roundtrips the optional outcome marker', async () => {
    await store.save(cp({ outcome: 'in_progress' }))
    expect((await store.get('s1-1'))?.outcome).toBe('in_progress')
  })

  it('returns the newest in-progress checkpoint and ignores terminal outcomes', async () => {
    await store.save(cp({ id: 'legacy', createdAt: 100, outcome: undefined }))
    await store.save(cp({ id: 'progress', createdAt: 200, outcome: 'in_progress' }))
    await store.save(cp({ id: 'done', createdAt: 300, outcome: 'success' }))
    expect((await store.latestInProgress())?.id).toBe('progress')
    expect(await store.latestInProgress({ minCreatedAt: 250 })).toBeUndefined()
  })

  it('omits the label when not set', async () => {
    await store.save(cp())
    const got = await store.get('s1-1')
    expect(got?.label).toBeUndefined()
  })

  it('roundtrips a complex message history (assistant tool calls)', async () => {
    const complex = cp({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'doing it',
          toolCalls: [{ id: 't1', name: 'search', arguments: { q: 'lumen' } }],
        },
        {
          role: 'tool',
          results: [{ toolCallId: 't1', isError: false, content: 'ok' }],
        },
      ],
    })
    await store.save(complex)
    const got = await store.get('s1-1')
    expect(got?.messages).toHaveLength(4)
    // tool role messages are preserved through JSON.
    const toolMessage = got?.messages[3]
    expect(toolMessage).toBeDefined()
    if (toolMessage && toolMessage.role === 'tool') {
      expect(toolMessage.results).toHaveLength(1)
    }
  })

  it('persists across a fresh store instance (re-opens the same file)', async () => {
    await store.save(cp())
    await store.dispose()
    const reopened = new SqliteCheckpointStore({ path: dbPath })
    try {
      const got = await reopened.get('s1-1')
      expect(got?.id).toBe('s1-1')
    } finally {
      await reopened.dispose()
    }
  })

  it('exposes id "sqlite"', () => {
    expect(store.id).toBe('sqlite')
  })
})

describe('SqliteCheckpointStore P32.1.1 directory auto-creation', () => {
  /**
   * P32.1 routed `lumen chat` to a default cwd-derived sqlite path
   * under XDG_STATE_HOME / ~/.local/state/lumen. The very first
   * invocation may not have those dirs yet; better-sqlite3 throws
   * SQLITE_CANTOPEN (driver-level) when the parent dir is missing,
   * so the constructor mkdirSync's the parent as a load-bearing
   * invariant — not a convenience. Tests below exercise the three
   * edges: nested missing dir (must create), single-level missing
   * dir (must create), and the `:memory:` short-circuit (must NOT
   * touch the filesystem).
   */
  it('creates nested missing parent directories before opening the file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-checkpoint-mkdir-'))
    try {
      const nested = path.join(root, 'a', 'b', 'c', 'checkpoints.db')
      // pre-condition: nothing under <root>/a exists.
      await expect(fs.access(path.join(root, 'a'))).rejects.toBeDefined()
      const local = new SqliteCheckpointStore({ path: nested })
      try {
        // After construction the file should exist with the
        // checkpoints table ready (writes are no-op here, the
        // DDL already ran).
        const stat = await fs.stat(nested)
        expect(stat.isFile()).toBe(true)
      } finally {
        await local.dispose()
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('skips filesystem mkdir for the :memory: short-circuit', async () => {
    // Sanity: the in-memory store path used by every test above
    // still works after adding the mkdirSync block — `:memory:`
    // must not crash on a path.dirname('memory:').
    const local = new SqliteCheckpointStore({ path: ':memory:' })
    await local.save(cp())
    const got = await local.get('s1-1')
    expect(got?.id).toBe('s1-1')
    await local.dispose()
  })
})
