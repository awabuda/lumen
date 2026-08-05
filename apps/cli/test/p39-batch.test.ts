/**
 * P39.a + P39.b + P39.c + P39.d — four P+ slices in one test file.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configGetCommand } from '../src/commands/config.js'
import { memoryShowCommand } from '../src/commands/memory.js'
import { planShowCommand } from '../src/commands/plan.js'
import { teamCommand } from '../src/commands/team.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p39-'))
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

describe('P39.a — lumen plan show <id> --format json', () => {
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

describe('P39.b — lumen memory show --format json', () => {
  it('emits a structured JSON object when the store is empty', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await memoryShowCommand({ memoryPath: dbPath, format: 'json' })
      expect(code).toBe(0)
      const parsed = JSON.parse(cap.writes.join('')) as {
        memoryMdPath: string
        userMdPath: string
        lastSyncMs: number
        lastSyncIso: string | null
      }
      expect(typeof parsed.memoryMdPath).toBe('string')
      expect(typeof parsed.userMdPath).toBe('string')
      expect(parsed.lastSyncMs).toBe(0)
      expect(parsed.lastSyncIso).toBeNull()
    } finally {
      cap.restore()
    }
  })
})

describe('P39.c — lumen team validate --format json', () => {
  it('emits a structured JSON object for a valid team.json', async () => {
    const teamPath = path.join(tmpDir, 'team.json')
    await fs.writeFile(
      teamPath,
      JSON.stringify({
        name: 'p39-c-team',
        description: 'P39.c test',
        mode: 'sequential',
        agents: [{ name: 'a', description: 'a desc', systemPrompt: 'x' }],
        tasks: [{ agentName: 'a', prompt: 'y' }],
      }),
      'utf8',
    )
    const cap = capture()
    try {
      const code = await teamCommand({ action: 'validate', path: teamPath, format: 'json' })
      expect(code).toBe(0)
      const parsed = JSON.parse(cap.writes.join('')) as {
        name: string
        mode: string
        agents: string[]
        tasks: number
      }
      expect(parsed.name).toBe('p39-c-team')
      expect(parsed.mode).toBe('sequential')
      expect(parsed.agents).toEqual(['a'])
      expect(parsed.tasks).toBe(1)
    } finally {
      cap.restore()
    }
  })
})

describe('P39.d — lumen config get <dotted-path>', () => {
  it('returns `null` on stdout for an unknown path', async () => {
    const cap = capture()
    try {
      const code = await configGetCommand({ path: 'does.not.exist' })
      expect(code).toBe(0)
      expect(cap.writes.join('').trim()).toBe('null')
    } finally {
      cap.restore()
    }
  })

  it('returns 2 + stderr when the path argument is empty', async () => {
    const cap = capture()
    try {
      const code = await configGetCommand({ path: '' })
      expect(code).toBe(2)
      expect(cap.stderr.join('')).toMatch(/missing <path> argument/)
    } finally {
      cap.restore()
    }
  })
})
