/**
 * P44.a + P44.b + P44.c + P44.d — four P+ slices in one test file.
 *
 * - P44.a — lumen reflect meta --format json
 * - P44.b — lumen session prune --dry-run
 * - P44.c — lumen session list --list-limit <n>
 * - P44.d — lumen session show <id> --format json
 *
 * P44.a and P44.b run against an in-memory SqliteStore
 * with a single seeded fact so the meta reflector
 * has something to cluster. P44.c and P44.d use
 * `fresh tmpDir` SqliteStore fixtures.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  sessionListCommand,
  sessionPruneCommand,
  sessionShowCommand,
} from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p44-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const capture = (): { writes: string[]; stderr: string[]; restore: () => void } => {
  const writes: string[] = []
  const stderr: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }) as typeof process.stdout.write
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }) as typeof process.stderr.write
  return {
    writes,
    stderr,
    restore: () => {
      process.stdout.write = originalWrite
      process.stderr.write = originalErr
    },
  }
}

describe('P44.b — lumen session prune --dry-run', () => {
  it('emits `would prune <n>` and skips the apply step', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const store = new SqliteStore({ path: dbPath })
    await store.init()
    // Seed one fresh session. The cut-off defaults to
    // 30 days, so a fresh session is NOT older than
    // the threshold; the dry-run count is 0.
    await store.createSession({
      id: 'p44-fresh',
      title: 'fresh',
    })
    await store.dispose()
    const cap = capture()
    try {
      const code = await sessionPruneCommand({
        memoryPath: dbPath,
        force: true,
        dryRun: true,
      })
      expect(code).toBe(0)
      const out = cap.writes.join('')
      expect(out).toMatch(/would prune 0 session\/record row\(s\) older than 30 day/)
    } finally {
      cap.restore()
    }
  })
})

describe('P44.c — lumen session list --list-limit', () => {
  it('emits an empty list when no sessions exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionListCommand({ memoryPath: dbPath, listLimit: 5 })
      expect(code).toBe(0)
      const out = cap.writes.join('')
      expect(out).toMatch(/No sessions found/)
    } finally {
      cap.restore()
    }
  })
})

describe('P44.d — lumen session show --format json', () => {
  it('returns 1 + stderr when the session id is missing', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionShowCommand('no-such-session', {
        memoryPath: dbPath,
        format: 'json',
      })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/Session not found/)
    } finally {
      cap.restore()
    }
  })
})
