/**
 * P48.d + P48.h — two P+ slices in one test file.
 *
 * P48.c (memory show --no-redact-trust) and
 * P48.e (reflect meta --dry-run) were withdrawn
 * during the patch tool iterations:
 *   - P48.c collided with the pre-existing
 *     `noTrust` field (P45.d) on the same
 *     `MemoryCommandOptions` interface.
 *   - P48.e required a `try / catch` rewrite of
 *     `reflectMetaCommand` and the patch tool
 *     could not land the change without
 *     truncating the function.
 *
 * - P48.d — lumen reflect list --list-limit <n>
 *           (renamed from --limit to match the
 *           P44.c session list --list-limit
 *           convention)
 * - P48.h — lumen session delete <id> --no-load
 *           (skip the P45.a session + message
 *           load; emit `lastAccessMs: null`
 *           instead of the most-recent message
 *           `createdAt`)
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reflectListCommand } from '../src/commands/reflect.js'
import { sessionDeleteCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p48-'))
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

describe('P48.d — lumen reflect list --list-limit', () => {
  it('emits `(no reflection records ...)` when no records exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await reflectListCommand({ memoryPath: dbPath, listLimit: 5 })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/no reflection records/)
    } finally {
      cap.restore()
    }
  })
})

describe('P48.h — lumen session delete --no-load', () => {
  it('returns 1 + stderr when the session id is missing', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionDeleteCommand('no-such-session', {
        memoryPath: dbPath,
        force: true,
        noLoad: true,
        format: 'json',
      })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/Session not found/)
    } finally {
      cap.restore()
    }
  })
})
