/**
 * P47.a + P47.c + P47.d + P47.e — four P+ slices in one test file.
 *
 * - P47.a — lumen plan reject --dry-run
 * - P47.c — lumen session show <id> --include-metadata
 * - P47.d — lumen memory list --exclude-kind
 * - P47.e — lumen plan list --since-ms
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryListCommand } from '../src/commands/memory.js'
import { planListCommand, planRejectCommand } from '../src/commands/plan.js'
import { sessionShowCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p47-'))
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

describe('P47.a — lumen plan reject --dry-run', () => {
  it('returns 1 + stderr when the plan id is missing', async () => {
    const plansPath = path.join(tmpDir, 'plans.json')
    const cap = capture()
    try {
      const code = await planRejectCommand({
        id: 'no-such-plan',
        file: plansPath,
        dryRun: true,
      })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/no plan with id "no-such-plan"/)
    } finally {
      cap.restore()
    }
  })
})

describe('P47.c — lumen session show --include-metadata', () => {
  it('returns 1 + stderr when the session id is missing', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionShowCommand('no-such-session', {
        memoryPath: dbPath,
        includeMetadata: true,
      })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/Session not found/)
    } finally {
      cap.restore()
    }
  })
})

describe('P47.d — lumen memory list --exclude-kind', () => {
  it('emits an empty list when no records exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await memoryListCommand({
        memoryPath: dbPath,
        excludeKind: 'reflection',
        format: 'json',
      })
      expect(code).toBe(0)
      expect(cap.writes.join('').trim()).toBe('[]')
    } finally {
      cap.restore()
    }
  })
})

describe('P47.e — lumen plan list --since-ms', () => {
  it('returns 0 with `(no plans in <file>)` when no plans exist', async () => {
    const plansPath = path.join(tmpDir, 'plans.json')
    const cap = capture()
    try {
      const code = await planListCommand({
        file: plansPath,
        sinceMs: Date.now() - 60_000,
      })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/no plans/)
    } finally {
      cap.restore()
    }
  })
})
