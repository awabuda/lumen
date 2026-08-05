/**
 * P35.f — `lumen session list --format json` tests.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionListCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p35-f-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('sessionListCommand --format json — P35.f', () => {
  it('emits [] when no sessions exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await sessionListCommand({
        memoryPath: dbPath,
        format: 'json',
      })
      expect(code).toBe(0)
      expect(writes.join('').trim()).toBe('[]')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits a JSON array of session rows when --format json is set', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const store = new SqliteStore({ path: dbPath })
    await store.init()
    try {
      await store.createSession({ id: 's-1', title: 'first' })
      await store.createSession({ id: 's-2', title: 'second' })
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
      const code = await sessionListCommand({
        memoryPath: dbPath,
        format: 'json',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as Array<{
        id: string
        title: string | null
      }>
      expect(parsed).toHaveLength(2)
      const ids = parsed.map((s) => s.id).sort()
      expect(ids).toEqual(['s-1', 's-2'])
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('keeps pre-P35.f human output when --format is omitted', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const store = new SqliteStore({ path: dbPath })
    await store.init()
    try {
      await store.createSession({ id: 's-x', title: 'human' })
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
      const code = await sessionListCommand({
        memoryPath: dbPath,
      })
      expect(code).toBe(0)
      const out = writes.join('')
      expect(out).toMatch(/Lumen sessions/)
      expect(out).toMatch(/s-x/)
      expect(out).toMatch(/human/)
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
