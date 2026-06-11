/** Tests for `lumen session` command handlers. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '@lumen/memory'
import {
  sessionDeleteCommand,
  sessionListCommand,
  sessionPruneCommand,
  sessionShowCommand,
} from '../src/commands/session.js'

let tmpDir: string
let memoryPath: string
let stdout = ''
let stderr = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-cli-session-test-'))
  memoryPath = path.join(tmpDir, 'memory.db')
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/**
 * Pre-seed the SQLite store with a known set of sessions
 * directly so the CLI tests don't have to round-trip through
 * the agent. We use the same SqliteStore class the agent uses,
 * then point the CLI at the same file.
 */
const seedStore = async (sessions: ReadonlyArray<{ id: string; title?: string }>): Promise<void> => {
  const store = new SqliteStore({ path: memoryPath })
  await store.init()
  try {
    for (const s of sessions) {
      await store.createSession({ id: s.id, title: s.title })
    }
  } finally {
    await store.dispose()
  }
}

describe('sessionListCommand', () => {
  it('prints empty state when no sessions exist', async () => {
    const code = await sessionListCommand({ memoryPath })
    expect(code).toBe(0)
    expect(stdout).toContain('Lumen sessions')
    expect(stdout).toContain('No sessions found')
  })

  it('lists every seeded session', async () => {
    await seedStore([
      { id: 'a', title: 'alpha' },
      { id: 'b', title: 'beta' },
    ])
    const code = await sessionListCommand({ memoryPath })
    expect(code).toBe(0)
    expect(stdout).toContain('  a  ')
    expect(stdout).toContain('alpha')
    expect(stdout).toContain('  b  ')
    expect(stdout).toContain('beta')
  })

  it('does not crash on a missing memory file', async () => {
    const code = await sessionListCommand({ memoryPath: path.join(tmpDir, 'does-not-exist.db') })
    expect(code).toBe(0)
    expect(stdout).toContain('No sessions found')
  })
})

describe('sessionShowCommand', () => {
  it('prints full session with messages', async () => {
    const store = new SqliteStore({ path: memoryPath })
    await store.init()
    try {
      await store.createSession({ id: 'demo', title: 'demo session' })
      await store.appendMessage({ sessionId: 'demo', role: 'user', content: 'hello' })
      await store.appendMessage({ sessionId: 'demo', role: 'assistant', content: 'hi there' })
    } finally {
      await store.dispose()
    }
    const code = await sessionShowCommand('demo', { memoryPath })
    expect(code).toBe(0)
    expect(stdout).toContain('Session demo')
    expect(stdout).toContain('demo session')
    expect(stdout).toContain('messages:  2')
    expect(stdout).toContain('hello')
    expect(stdout).toContain('hi there')
  })

  it('returns 1 for an unknown session', async () => {
    const code = await sessionShowCommand('missing', { memoryPath })
    expect(code).toBe(1)
    expect(stderr).toContain('Session not found')
  })
})

describe('sessionDeleteCommand', () => {
  it('refuses without --force', async () => {
    await seedStore([{ id: 's', title: 'doomed' }])
    const code = await sessionDeleteCommand('s', { memoryPath })
    expect(code).toBe(2)
    expect(stderr).toContain('without --force')
  })

  it('deletes with --force', async () => {
    await seedStore([{ id: 's', title: 'doomed' }])
    const code = await sessionDeleteCommand('s', { memoryPath, force: true })
    expect(code).toBe(0)
    expect(stdout).toContain('Deleted session: s')
    // Verify the deletion persisted
    const verify = new SqliteStore({ path: memoryPath })
    await verify.init()
    try {
      expect(await verify.getSession('s')).toBeUndefined()
    } finally {
      await verify.dispose()
    }
  })

  it('returns 1 for an unknown id', async () => {
    const code = await sessionDeleteCommand('missing', { memoryPath, force: true })
    expect(code).toBe(1)
    expect(stderr).toContain('Session not found')
  })
})

describe('sessionPruneCommand', () => {
  it('refuses without --force', async () => {
    const code = await sessionPruneCommand({ memoryPath, olderThanDays: 0 })
    expect(code).toBe(2)
    expect(stderr).toContain('without --force')
  })

  it('prunes old sessions with --force', async () => {
    await seedStore([{ id: 'old', title: 'old' }, { id: 'new', title: 'new' }])
    const code = await sessionPruneCommand({ memoryPath, force: true, olderThanDays: 0 })
    expect(code).toBe(0)
    expect(stdout).toMatch(/Pruned \d+ session\/record row/)
  })

  it('rejects negative --older-than', async () => {
    const code = await sessionPruneCommand({ memoryPath, force: true, olderThanDays: -1 })
    expect(code).toBe(2)
    expect(stderr).toContain('non-negative')
  })
})
