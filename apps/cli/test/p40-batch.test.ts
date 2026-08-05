/**
 * P40.a + P40.b + P40.c + P40.d — four P+ slices in one test file.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryCheckpointStore } from '@lumen/core'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointDeleteCommand } from '../src/commands/checkpoint.js'
import { memoryShowCommand } from '../src/commands/memory.js'
import { teamCommand } from '../src/commands/team.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p40-'))
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

describe('P40.a — lumen team show <path> --format json', () => {
  it('emits a JSON object for a valid team.json', async () => {
    const teamPath = path.join(tmpDir, 'team.json')
    await fs.writeFile(
      teamPath,
      JSON.stringify({
        name: 'p40-a-team',
        description: 'P40.a test',
        mode: 'sequential',
        agents: [{ name: 'a', description: 'a', systemPrompt: 'x' }],
        tasks: [{ agentName: 'a', prompt: 'y' }],
      }),
      'utf8',
    )
    const cap = capture()
    try {
      const code = await teamCommand({ action: 'show', path: teamPath, format: 'json' })
      expect(code).toBe(0)
      const parsed = JSON.parse(cap.writes.join('')) as { name: string }
      expect(parsed.name).toBe('p40-a-team')
    } finally {
      cap.restore()
    }
  })
})

describe('P40.b — lumen checkpoint delete --format json', () => {
  it('emits a JSON object after a successful delete', async () => {
    const store = new InMemoryCheckpointStore()
    // Seed a checkpoint via the store directly.
    await store.save({
      id: 'cp-p40-b',
      sessionId: 's',
      iterations: 1,
      createdAt: Date.now(),
      messages: [],
      outcome: 'in_progress',
    })
    const cap = capture()
    try {
      const code = await checkpointDeleteCommand({ id: 'cp-p40-b', store, format: 'json' })
      expect(code).toBe(0)
      const parsed = JSON.parse(cap.writes.join('')) as {
        id: string
        deleted: boolean
        deletedAt: number
      }
      expect(parsed.id).toBe('cp-p40-b')
      expect(parsed.deleted).toBe(true)
      expect(typeof parsed.deletedAt).toBe('number')
    } finally {
      cap.restore()
    }
  })
})

describe('P40.c — lumen memory show --verbose', () => {
  it('lists per-kind counts when --verbose is set (human path)', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const store = new SqliteStore({ path: dbPath })
    await store.init()
    try {
      await store.put({ id: 'f1', kind: 'fact', content: 'a', trust: 0.7, tags: [] })
      await store.put({ id: 'f2', kind: 'fact', content: 'b', trust: 0.7, tags: [] })
      await store.put({ id: 'r1', kind: 'reflection', content: 'c', trust: 0.5, tags: [] })
    } finally {
      await store.dispose()
    }
    const cap = capture()
    try {
      const code = await memoryShowCommand({ memoryPath: dbPath, verbose: true })
      expect(code).toBe(0)
      const out = cap.writes.join('')
      expect(out).toMatch(/fact=2/)
      expect(out).toMatch(/reflection=1/)
    } finally {
      cap.restore()
    }
  })
})
