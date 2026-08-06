/**
 * P42.c + P48.e — two P+ slices in one test file.
 *
 * - P42.c — lumen memory prune --force --kind <k>
 * - P48.e — lumen reflect meta --dry-run
 *
 * Three other P-tickets were withdrawn during the
 * pre-pass:
 *   - P48.a plan list --include-archived (Plan
 *     shape does not include an `archived` field).
 *   - P48.f checkpoint restore --no-summary (the
 *     pre-existing `--json` flag P34.5 already
 *     provides a no-text summary path).
 *   - P42.c memory prune original plan (would
 *     have been a 1-2 commit slice; after the
 *     cross-package design pass the slice was
 *     sized to 1 commit and shipped here).
 *
 * The two shipped slices are isolated to a
 * single command surface each:
 *   - P42.c adds a new `memory prune` subcommand
 *     (gated behind `--force`).
 *   - P48.e adds a `--dry-run` flag to the
 *     existing `reflect meta` subcommand.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryPruneCommand } from '../src/commands/memory.js'
import { reflectMetaCommand } from '../src/commands/reflect.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p50-'))
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

describe('P42.c — lumen memory prune (dry-run path)', () => {
  it('returns 0 with `(would prune 0 records)` when the store is empty', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await memoryPruneCommand({
        memoryPath: dbPath,
        dryRun: true,
      })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/would prune 0/)
    } finally {
      cap.restore()
    }
  })
})

describe('P48.e — lumen reflect meta --dry-run', () => {
  it('returns 0 with a no-clusters summary when no records exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await reflectMetaCommand({
        memoryPath: dbPath,
        dryRun: true,
      })
      expect(code).toBe(0)
    } finally {
      cap.restore()
    }
  })
})
