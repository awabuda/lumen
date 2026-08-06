/**
 * P51.b — `lumen memory show --trust-distribution`
 * emits an 11-bucket trust histogram (0.0 / 0.1 /
 * ... / 1.0) alongside the per-kind count. Bug
 * #71 (`/cost` / `/usage`) maps to `lumen run
 * --stat` (P38.c) + this slice. P51.a
 * (`lumen cost` CLI subcommand) was withdrawn
 * after the audit — `lumen run --stat` already
 * surfaces the budget; an alias would add no
 * value. P51.b is the only 1-2 commit slice
 * that ships against the 5 follow-up classes
 * (P29.1 / P29.2 / TUI / Phase C / 29 release
 * tag push are all out of scope for a single
 * commit).
 *
 * The test exercises the JSON path with an
 * empty store (the histogram is zero-count
 * for all 11 buckets, but the keys are
 * present so CI can pipe through `jq` without
 * missing-key errors).
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryShowCommand } from '../src/commands/memory.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p51-'))
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

describe('P51.b — lumen memory show --trust-distribution', () => {
  it('emits an 11-bucket histogram in the JSON output', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await memoryShowCommand({
        memoryPath: dbPath,
        format: 'json',
        verbose: true,
        trustDistribution: true,
      })
      expect(code).toBe(0)
      const payload = JSON.parse(cap.writes.join('').trim())
      const keys = Object.keys(payload.trustDistribution)
      expect(keys.length).toBe(11)
      for (const k of keys) {
        expect(payload.trustDistribution[k]).toBe(0)
      }
    } finally {
      cap.restore()
    }
  })
})
