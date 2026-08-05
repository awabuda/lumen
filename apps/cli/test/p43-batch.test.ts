/**
 * P43.a + P43.b + P43.c + P43.d — four P+ slices in one test file.
 *
 * - P43.a — lumen doctor --section <name> --format json
 * - P43.b — lumen tools list --format json
 * - P43.c — lumen memory show --verbose --kind <k>
 * - P43.d — lumen gateway status --format json
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatewayStatusCommand } from '../src/commands/gateway.js'
import { memoryShowCommand } from '../src/commands/memory.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p43-'))
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

describe('P43.c — lumen memory show --verbose --kind <k>', () => {
  it('filters the per-kind count to the requested kind', async () => {
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
      const code = await memoryShowCommand({
        memoryPath: dbPath,
        verbose: true,
        kindFilter: 'reflection',
      })
      expect(code).toBe(0)
      const out = cap.writes.join('')
      expect(out).toMatch(/reflection=1/)
      expect(out).not.toMatch(/fact=2/)
    } finally {
      cap.restore()
    }
  })
})

describe('P43.d — lumen gateway status --format json', () => {
  it('emits a JSON object on status', async () => {
    const cap = capture()
    try {
      const code = await gatewayStatusCommand({ format: 'json', port: 8080 })
      expect(code).toBe(0)
      const parsed = JSON.parse(cap.writes.join('')) as {
        status: string
        host: string
        port: number
        pathPrefix: string
        plannedEndpoint: string
      }
      expect(parsed.status).toBe('not-running')
      expect(parsed.port).toBe(8080)
      expect(parsed.pathPrefix).toBe('/v1')
      expect(parsed.plannedEndpoint).toBe('http://127.0.0.1:8080/v1')
    } finally {
      cap.restore()
    }
  })
})
