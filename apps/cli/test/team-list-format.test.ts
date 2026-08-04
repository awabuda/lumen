/**
 * P34.6 — `lumen team list --format json / --recursive`.
 *
 * Verifies the two new flags on the `list` action:
 *   - `--format json` emits a single JSON array (CI
 *     pipelines can diff against the listing).
 *   - `--recursive` recurses into sub-directories.
 *   - `--format human` (the default) keeps the
 *     pre-P34.6 behaviour.
 *   - empty directory in `--format json` emits `[]\n`
 *     (deterministic for CI).
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { teamCommand } from '../src/commands/team.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p34-6-'))
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

const sampleTeam = (name: string): object => ({
  name,
  description: `sample team ${name}`,
  mode: 'sequential',
  agents: [
    { name: 'researcher', description: 'researcher desc', systemPrompt: 'research' },
    { name: 'writer', description: 'writer desc', systemPrompt: 'write' },
  ],
  tasks: [{ agentName: 'researcher', prompt: 'investigate X' }],
})

describe('lumen team list — P34.6 --format / --recursive', () => {
  it('emits a JSON array when --format json is set', async () => {
    await writeTeam('alpha.team.json', sampleTeam('alpha'))
    await writeTeam('beta.team.json', sampleTeam('beta'))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({
        action: 'list',
        listDir: tmpRoot,
        format: 'json',
      })
      expect(code).toBe(0)
      const out = writes.join('')
      const parsed = JSON.parse(out) as Array<{ name: string; path: string; mode: string }>
      expect(parsed).toHaveLength(2)
      const names = parsed.map((p) => p.name).sort()
      expect(names).toEqual(['alpha', 'beta'])
      for (const entry of parsed) {
        expect(entry.mode).toBe('sequential')
        expect(entry.path.startsWith(tmpRoot)).toBe(true)
      }
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits [] for an empty directory in --format json', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({
        action: 'list',
        listDir: tmpRoot,
        format: 'json',
      })
      expect(code).toBe(0)
      expect(writes.join('').trim()).toBe('[]')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('keeps the pre-P34.6 human output by default', async () => {
    await writeTeam('alpha.team.json', sampleTeam('alpha'))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({ action: 'list', listDir: tmpRoot })
      expect(code).toBe(0)
      const out = writes.join('')
      expect(out).toMatch(/Lumen teams under/)
      expect(out).toMatch(/name=alpha/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('recurses into sub-directories when --recursive is set', async () => {
    // Nested team — only visible with --recursive.
    await writeTeam('team-a/team.json', sampleTeam('top'))
    await writeTeam('team-a/nested/deep/team.json', sampleTeam('deep'))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({
        action: 'list',
        listDir: tmpRoot,
        recursive: true,
        format: 'json',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as Array<{ name: string }>
      const names = parsed.map((p) => p.name).sort()
      expect(names).toEqual(['deep', 'top'])
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('does NOT recurse when --recursive is omitted (pre-P34.6 behaviour)', async () => {
    await writeTeam('top.team.json', sampleTeam('top'))
    await writeTeam('team-a/nested/deep/team.json', sampleTeam('deep'))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await teamCommand({
        action: 'list',
        listDir: tmpRoot,
        format: 'json',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as Array<{ name: string }>
      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.name).toBe('top')
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
