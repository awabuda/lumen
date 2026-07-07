/** Tests for `lumen reflect` command handlers. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteStore } from '@lumen/memory'
import { reflectMetaCommand, reflectRunCommand } from '../src/commands/reflect.js'

let tmpDir: string
let memoryPath: string
let stdout = ''
let stderr = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-cli-reflect-test-'))
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
 * Seed a session whose assistant message contains a phrase that
 * the rule-based reflector recognises ("The user prefers ...").
 */
const seedSession = async (): Promise<string> => {
  const store = new SqliteStore({ path: memoryPath })
  await store.init()
  try {
    const session = await store.createSession({
      id: 'reflect-test-session',
      title: 'reflect test',
    })
    await store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'How do I set up tests?',
    })
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'The user prefers vitest with TypeScript. That is the recommended setup.',
    })
    return session.id
  } finally {
    await store.dispose()
  }
}

describe('lumen reflect run', () => {
  it('extracts facts from the most recent session and persists them', async () => {
    await seedSession()
    const code = await reflectRunCommand({ memoryPath })
    expect(code).toBe(0)
    expect(stdout).toMatch(/reflected \d+\/\d+ facts/)
    expect(stderr).toBe('')
  })

  it('prints a (no sessions ...) hint when the store is empty', async () => {
    const code = await reflectRunCommand({ memoryPath })
    expect(code).toBe(0)
    expect(stdout).toContain('(no sessions')
  })

  it('returns exit 1 when the explicit session id is unknown', async () => {
    await seedSession()
    const code = await reflectRunCommand({
      memoryPath,
      sessionId: 'no-such-session',
    })
    expect(code).toBe(1)
    expect(stderr).toContain('not found')
  })
})

describe('lumen reflect meta', () => {
  it('reports (no fact clusters ...) when there is nothing to cluster', async () => {
    // Seed an empty store: init + dispose leaves a valid empty db.
    const store = new SqliteStore({ path: memoryPath })
    await store.init()
    await store.dispose()

    const code = await reflectMetaCommand({ memoryPath })
    expect(code).toBe(0)
    expect(stdout).toContain('(no fact clusters')
  })

  it('does not throw when the database file is auto-created (sqlite opens fresh)', async () => {
    // better-sqlite3 opens a fresh file on disk, so the meta reflector
    // runs against an empty store and reports (no fact clusters ...).
    const code = await reflectMetaCommand({ memoryPath: path.join(tmpDir, 'fresh.db') })
    expect(code).toBe(0)
    expect(stdout).toContain('(no fact clusters')
  })
})
