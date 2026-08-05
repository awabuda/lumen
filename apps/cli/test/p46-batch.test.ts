/**
 * P46.a + P46.b + P46.c + P46.d — four P+ slices in one test file.
 *
 * - P46.a — lumen plan show <id> --no-notes
 * - P46.b — lumen plan approve --dry-run
 * - P46.c — lumen apply-patch --quiet
 * - P46.d — lumen session list --since-ms
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatchCommand } from '../src/commands/apply-patch.js'
import { planApproveCommand, planShowCommand } from '../src/commands/plan.js'
import { sessionListCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p46-'))
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

describe('P46.a — lumen plan show --no-notes', () => {
  it('returns 1 + stderr when the plan id is missing', async () => {
    const plansPath = path.join(tmpDir, 'plans.json')
    const cap = capture()
    try {
      const code = await planShowCommand({ id: 'no-such-plan', file: plansPath })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/no plan with id "no-such-plan"/)
    } finally {
      cap.restore()
    }
  })
})

describe('P46.b — lumen plan approve --dry-run', () => {
  it('returns 1 + stderr when the plan id is missing', async () => {
    const plansPath = path.join(tmpDir, 'plans.json')
    const cap = capture()
    try {
      const code = await planApproveCommand({
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

describe('P46.c — lumen apply-patch --quiet', () => {
  it('returns 2 + stderr when the patch file is missing', async () => {
    const patchPath = path.join(tmpDir, 'missing.patch')
    const cap = capture()
    try {
      const code = await applyPatchCommand({
        path: patchPath,
        quiet: true,
      })
      expect(code).toBe(2)
      expect(cap.stderr.join('')).toMatch(/cannot read/)
    } finally {
      cap.restore()
    }
  })
})

describe('P46.d — lumen session list --since-ms', () => {
  it('emits an empty list when no sessions exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionListCommand({
        memoryPath: dbPath,
        sinceMs: Date.now() - 60_000,
      })
      expect(code).toBe(0)
      expect(cap.writes.join('')).toMatch(/No sessions found/)
    } finally {
      cap.restore()
    }
  })
})
