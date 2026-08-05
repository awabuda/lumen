/**
 * P34.10 — `lumen team run --dry-run` tests.
 *
 * Verifies the new `--dry-run` flag on the `run` action
 * skips buildAgent / orchestrateTeam entirely and just
 * resolves the team's plan (agents × tasks), emitting
 * one line per task. Two output formats:
 *   - human (default): one header + one task per line
 *   - json: a single JSON object
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { teamCommand } from '../src/commands/team.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p34-10-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const writeTeam = async (relPath: string, body: object): Promise<string> => {
  const full = path.join(tmpRoot, relPath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, JSON.stringify(body), 'utf8')
  return full
}

const sampleTeam = (): object => ({
  name: 'p34-10-team',
  description: 'P34.10 dry-run test team',
  mode: 'sequential',
  agents: [
    { name: 'researcher', description: 'researcher desc', systemPrompt: 'research' },
    { name: 'writer', description: 'writer desc', systemPrompt: 'write' },
  ],
  tasks: [
    { agentName: 'researcher', prompt: 'investigate X' },
    { agentName: 'writer', prompt: 'draft summary' },
  ],
})

describe('lumen team run --dry-run — P34.10', () => {
  it('skips orchestrateTeam and prints a one-line-per-task preview', async () => {
    const path = await writeTeam('team.json', sampleTeam())
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      // No runParent — dry-run must not require it.
      const code = await teamCommand({ action: 'run', path, dryRun: true })
      expect(code).toBe(0)
      const out = writes.join('')
      expect(out).toMatch(/\[dry-run\] team \"p34-10-team\"/)
      expect(out).toMatch(/\[1\/2\] researcher {2}investigate X/)
      expect(out).toMatch(/\[2\/2\] writer {2}draft summary/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits JSON when --format json is set', async () => {
    const path = await writeTeam('team.json', sampleTeam())
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({
        action: 'run',
        path,
        dryRun: true,
        format: 'json',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as {
        name: string
        mode: string
        agents: string[]
        tasks: Array<{ index: number; agentName: string; prompt: string }>
      }
      expect(parsed.name).toBe('p34-10-team')
      expect(parsed.mode).toBe('sequential')
      expect(parsed.agents).toEqual(['researcher', 'writer'])
      expect(parsed.tasks).toHaveLength(2)
      expect(parsed.tasks[0]?.agentName).toBe('researcher')
      expect(parsed.tasks[1]?.agentName).toBe('writer')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('falls back to implicit agent-only tasks when no tasks are declared', async () => {
    const full = sampleTeam()
    const { tasks: _tasks, ...team } = full
    void _tasks
    const path = await writeTeam('team.json', team)
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({ action: 'run', path, dryRun: true })
      expect(code).toBe(0)
      const out = writes.join('')
      expect(out).toMatch(/\[1\/2\] researcher {2}researcher desc/)
      expect(out).toMatch(/\[2\/2\] writer {2}writer desc/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('returns 1 when the team file fails to parse', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p34-10-bad-'))
    try {
      const full = path.join(root, 'team.json')
      await fs.writeFile(full, '{not valid json', 'utf8')
      const stderrWrites: string[] = []
      const originalErr = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString())
        return true
      }) as typeof process.stderr.write
      try {
        const code = await teamCommand({ action: 'run', path: full, dryRun: true })
        expect(code).toBe(1)
        expect(stderrWrites.join('')).toMatch(/not valid JSON/)
      } finally {
        process.stderr.write = originalErr
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
