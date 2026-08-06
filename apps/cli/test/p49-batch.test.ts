/**
 * P49.a + P49.b + P49.c + P49.d — four P+ slices in one test file.
 *
 * - P49.a — lumen session show <id> --no-content
 * - P49.b — lumen plan list --no-goal
 * - P49.c — lumen reflect list --no-content
 * - P49.d — lumen plan list --no-status
 *
 * All four are pure JSON-shape flex flags. The four
 * functions are exercised through their function paths
 * (no CLI subprocess) so the test surface stays
 * inside `apps/cli/test/`.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planListCommand } from '../src/commands/plan.js'
import { reflectListCommand } from '../src/commands/reflect.js'
import { sessionShowCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p49-'))
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

describe('P49.a — lumen session show --no-content', () => {
  it('returns 1 + stderr when the session id is missing', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionShowCommand('no-such-session', {
        memoryPath: dbPath,
        noContent: true,
      })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/Session not found/)
    } finally {
      cap.restore()
    }
  })
})

describe('P49.b — lumen plan list --no-goal', () => {
  it('returns 0 with `(no plans in <file>)` when no plans exist', async () => {
    const plansPath = path.join(tmpDir, 'plans.json')
    const cap = capture()
    try {
      const code = await planListCommand({
        file: plansPath,
        noGoal: true,
      })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/no plans/)
    } finally {
      cap.restore()
    }
  })
})

describe('P49.c — lumen reflect list --no-content', () => {
  it('emits `(no reflection records ...)` when no records exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await reflectListCommand({ memoryPath: dbPath, noContent: true })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/no reflection records/)
    } finally {
      cap.restore()
    }
  })
})

describe('P49.d — lumen plan list --no-status', () => {
  it('returns 0 with `(no plans in <file>)` when no plans exist', async () => {
    const plansPath = path.join(tmpDir, 'plans.json')
    const cap = capture()
    try {
      const code = await planListCommand({
        file: plansPath,
        noStatus: true,
      })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/no plans/)
    } finally {
      cap.restore()
    }
  })
})
