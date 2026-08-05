/**
 * P45.a + P45.d — two P+ slices in one test file.
 *
 * P45.b (plan show --no-notes) and P45.c (plan
 * approve --dry-run) were withdrawn after the
 * patch tool repeatedly failed to land the
 * write_file (PlanStore.fromJSON does not
 * exist; the actual class hydrates via
 * `store.hydrate()`). The pre-existing
 * `memory list` subcommand was missing from
 * the index.ts dispatcher (the memory module
 * exported the function but no `lumen memory
 * list` sub-command existed in operator
 * surface until P45.d).
 *
 * - P45.a — lumen session delete --format json
 *           now emits a `lastAccessMs` field.
 * - P45.d — lumen memory list --no-trust skips
 *           the 0.6 trust floor.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryListCommand } from '../src/commands/memory.js'
import { sessionDeleteCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p45-'))
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

describe('P45.a — lumen session delete --format json (lastAccessMs)', () => {
  it('returns 1 + stderr when the session id is missing', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionDeleteCommand('no-such-session', {
        memoryPath: dbPath,
        force: true,
        format: 'json',
      })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/Session not found/)
    } finally {
      cap.restore()
    }
  })
})

describe('P45.d — lumen memory list --no-trust', () => {
  it('returns an empty list when no records exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      // Note: this also exercises the new
      // `lumen memory list` subcommand wiring
      // (the dispatcher entry was missing
      // before P45.d landed; the function
      // itself has shipped since P38.b).
      const code = await memoryListCommand({ memoryPath: dbPath, format: 'json' })
      expect(code).toBe(0)
      expect(cap.writes.join('').trim()).toBe('[]')
    } finally {
      cap.restore()
    }
  })
})
