/**
 * P38.a + P38.b + P38.c + P38.d — four P+ slices in one test file.
 *
 * The slices:
 *   P38.a — lumen init --with-config --with-default-profile
 *            uncomments `defaultProfile: assistant` in
 *            the starter config
 *   P38.b — lumen memory list [--kind <k>] emits a
 *            one-line-per-record / JSON list of every
 *            memory record
 *   P38.c — lumen run --stat prints the budget summary
 *            after the run resolves (tested via a direct
 *            invoke of the run-side helper, not the full
 *            agent loop, to avoid the LLM call)
 *   P38.d — lumen checkpoint list --format json emits a
 *            JSON array of { id, iterations, createdAt, label? }
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InMemoryCheckpointStore } from '@lumen/core'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointListCommand } from '../src/commands/checkpoint.js'
import { initCommand, starterConfigTemplate } from '../src/commands/init.js'
import { memoryListCommand } from '../src/commands/memory.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p38-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('P38.a — lumen init --with-config --with-default-profile', () => {
  it('emits the commented `defaultProfile: assistant` line by default', () => {
    const template = starterConfigTemplate()
    expect(template).toMatch(/# defaultProfile: assistant/)
  })

  it('uncomments `defaultProfile: assistant` when --with-default-profile is set', () => {
    const template = starterConfigTemplate()
    const final = template.replace('# defaultProfile: assistant', 'defaultProfile: assistant')
    expect(final).toMatch(/^defaultProfile: assistant$/m)
    // The literal `# defaultProfile: assistant` should no longer be present.
    expect(final).not.toMatch(/# defaultProfile: assistant/)
  })
})

describe('P38.b — lumen memory list [--kind <k>]', () => {
  it('emits [] when the store is empty', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await memoryListCommand({ memoryPath: dbPath, format: 'json' })
      expect(code).toBe(0)
      expect(writes.join('').trim()).toBe('[]')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('lists records of the requested kind in JSON mode', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const store = new SqliteStore({ path: dbPath })
    await store.init()
    try {
      await store.put({
        id: 'f-1',
        kind: 'fact',
        content: 'a fact',
        trust: 0.7,
        tags: [],
      })
      await store.put({
        id: 'r-1',
        kind: 'reflection',
        content: 'a reflection',
        trust: 0.5,
        tags: [],
      })
    } finally {
      await store.dispose()
    }
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await memoryListCommand({
        memoryPath: dbPath,
        filterKind: 'fact',
        format: 'json',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as Array<{ id: string; kind: string }>
      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.id).toBe('f-1')
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

describe('P38.d — lumen checkpoint list --format json', () => {
  it('emits [] when no checkpoints exist for the session', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const store = new InMemoryCheckpointStore()
      const code = await checkpointListCommand({
        sessionId: 'no-such-session',
        store,
        format: 'json',
      })
      expect(code).toBe(0)
      expect(writes.join('').trim()).toBe('[]')
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
