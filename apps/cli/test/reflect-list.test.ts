/**
 * P35.d — `lumen reflect list` tests.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reflectListCommand } from '../src/commands/reflect.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p35-d-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const seed = async (
  dbPath: string,
  records: Array<{ id: string; content: string; trust: number; createdAt: number }>,
): Promise<void> => {
  const store = new SqliteStore({ path: dbPath })
  await store.init()
  try {
    for (const r of records) {
      await store.put({
        id: r.id,
        kind: 'reflection',
        content: r.content,
        trust: r.trust,
        tags: ['reflection'],
      })
    }
  } finally {
    await store.dispose()
  }
}

describe('reflectListCommand — P35.d', () => {
  it('emits no-records hint when the store is empty', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await reflectListCommand({ memoryPath: dbPath })
      expect(code).toBe(0)
      expect(writes.join('')).toMatch(/no reflection records/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('prints one record per line in default mode', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const now = Date.now()
    await seed(dbPath, [
      { id: 'r-1', content: 'fact A', trust: 0.7, createdAt: now - 1_000 },
      { id: 'r-2', content: 'fact B', trust: 0.5, createdAt: now },
    ])
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await reflectListCommand({ memoryPath: dbPath })
      expect(code).toBe(0)
      const out = writes.join('')
      expect(out).toMatch(/Reflection records \(2\):/)
      expect(out).toMatch(/r-1/)
      expect(out).toMatch(/r-2/)
      expect(out).toMatch(/trust=0\.70/)
      expect(out).toMatch(/trust=0\.50/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits JSON array when --format json is set', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const now = Date.now()
    await seed(dbPath, [{ id: 'r-x', content: 'fact X', trust: 0.8, createdAt: now }])
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await reflectListCommand({
        memoryPath: dbPath,
        format: 'json',
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as Array<{
        id: string
        trust: number
        content: string
      }>
      expect(parsed).toHaveLength(1)
      expect(parsed[0]?.id).toBe('r-x')
      expect(parsed[0]?.trust).toBeCloseTo(0.8)
      expect(parsed[0]?.content).toBe('fact X')
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
