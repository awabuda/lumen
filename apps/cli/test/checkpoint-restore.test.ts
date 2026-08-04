/**
 * P34.5 (Phase B.5) — checkpoint restore tests.
 *
 * Verifies the new `lumen checkpoint restore`
 * sub-command resolves a saved checkpoint by id,
 * sessionId, or latest-in-progress. Exercises the
 * InMemoryCheckpointStore for hermeticity.
 */

import {
  type AgentCheckpoint,
  type BaseCheckpointStore,
  InMemoryCheckpointStore,
} from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type CheckpointRestoreOptions,
  checkpointRestoreCommand,
} from '../src/commands/checkpoint.js'

const stub = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  id: 'cp-1',
  sessionId: 's-1',
  iterations: 1,
  createdAt: Date.now(),
  messages: [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi', toolCalls: [] },
  ],
  ...overrides,
})

let store: BaseCheckpointStore

beforeEach(() => {
  store = new InMemoryCheckpointStore()
})

afterEach(async () => {
  await store.dispose?.()
})

describe('checkpointRestoreCommand — P34.5', () => {
  it('resolves by explicit id', async () => {
    await store.save(stub({ id: 'cp-a' }))
    await store.save(stub({ id: 'cp-b' }))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await checkpointRestoreCommand({ id: 'cp-b', store })
      expect(code).toBe(0)
      expect(writes.join('')).toMatch(/cp-b/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('falls back to the latest in-progress checkpoint when no id is given', async () => {
    await store.save(stub({ id: 'cp-old', createdAt: 1_000 }))
    await store.save(stub({ id: 'cp-new', createdAt: 9_000 }))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await checkpointRestoreCommand({ store })
      expect(code).toBe(0)
      expect(writes.join('')).toMatch(/cp-new/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('scopes the latest-in-progress lookup by sessionId', async () => {
    await store.save(stub({ id: 'cp-a', sessionId: 's-1', createdAt: 9_000 }))
    await store.save(stub({ id: 'cp-b', sessionId: 's-2', createdAt: 8_000 }))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code: number = await checkpointRestoreCommand({
        sessionId: 's-2',
        store,
      })
      expect(code).toBe(0)
      expect(writes.join('')).toMatch(/cp-b/)
      expect(writes.join('')).not.toMatch(/cp-a/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits JSON when --json is set', async () => {
    await store.save(stub({ id: 'cp-json', sessionId: 's-json' }))
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code: number = await checkpointRestoreCommand({
        id: 'cp-json',
        json: true,
        store,
      })
      expect(code).toBe(0)
      const out = writes.join('')
      const parsed = JSON.parse(out) as AgentCheckpoint
      expect(parsed.id).toBe('cp-json')
      expect(parsed.sessionId).toBe('s-json')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('returns 1 + stderr message when the resolved checkpoint is missing', async () => {
    const stderrWrites: string[] = []
    const originalErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    try {
      const code: number = await checkpointRestoreCommand({
        id: 'does-not-exist',
        store,
      })
      expect(code).toBe(1)
      expect(stderrWrites.join('')).toMatch(/no checkpoint with id "does-not-exist"/)
    } finally {
      process.stderr.write = originalErr
    }
  })

  it('returns 1 + stderr message when no in-progress checkpoint exists', async () => {
    const stderrWrites: string[] = []
    const originalErr = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stderr.write
    try {
      const opts: CheckpointRestoreOptions = { sessionId: 'empty', store }
      const code: number = await checkpointRestoreCommand(opts)
      expect(code).toBe(1)
      expect(stderrWrites.join('')).toMatch(/no in-progress checkpoint for session "empty"/)
    } finally {
      process.stderr.write = originalErr
    }
  })
})
