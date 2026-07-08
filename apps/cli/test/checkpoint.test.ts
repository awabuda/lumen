/** Tests for `lumen checkpoint` command handlers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryCheckpointStore } from '@lumen/core'
import {
  checkpointDeleteCommand,
  checkpointListCommand,
  checkpointShowCommand,
} from '../src/commands/checkpoint.js'

let store: InMemoryCheckpointStore
let stdout = ''
let stderr = ''

beforeEach(() => {
  store = new InMemoryCheckpointStore()
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * Pre-seed a few checkpoints for a session.
 */
const seed = async (): Promise<void> => {
  await store.save({
    id: 's1-1',
    sessionId: 's1',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    iterations: 1,
    createdAt: 100,
  })
  await store.save({
    id: 's1-2',
    sessionId: 's1',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello back', toolCalls: [] },
    ],
    iterations: 2,
    createdAt: 200,
    label: 'after step 2',
  })
}

describe('lumen checkpoint list', () => {
  it('prints (no checkpoints ...) when the store is empty', async () => {
    const code = await checkpointListCommand({ sessionId: 's1', store })
    expect(code).toBe(0)
    expect(stdout).toContain('(no checkpoints for session s1)')
  })

  it('lists every checkpoint for the session, newest first', async () => {
    await seed()
    const code = await checkpointListCommand({ sessionId: 's1', store })
    expect(code).toBe(0)
    expect(stdout).toContain('Checkpoints for session s1 (2)')
    expect(stdout).toContain('- s1-2')
    expect(stdout).toContain('- s1-1')
    const s2Idx = stdout.indexOf('- s1-2')
    const s1Idx = stdout.indexOf('- s1-1')
    expect(s2Idx).toBeLessThan(s1Idx)
  })
})

describe('lumen checkpoint show', () => {
  it('prints the full checkpoint payload', async () => {
    await seed()
    const code = await checkpointShowCommand({ id: 's1-2', store })
    expect(code).toBe(0)
    expect(stdout).toContain('id:        s1-2')
    expect(stdout).toContain('sessionId: s1')
    expect(stdout).toContain('iterations: 2')
    expect(stdout).toContain('label:     "after step 2"')
    expect(stdout).toContain('messages:  3')
  })

  it('returns exit 1 when the id is unknown', async () => {
    const code = await checkpointShowCommand({ id: 'no-such-id', store })
    expect(code).toBe(1)
    expect(stderr).toContain('no checkpoint with id "no-such-id"')
  })
})

describe('lumen checkpoint delete', () => {
  it('removes the checkpoint and returns exit 0', async () => {
    await seed()
    const code = await checkpointDeleteCommand({ id: 's1-1', store })
    expect(code).toBe(0)
    expect(stdout).toContain('deleted s1-1')
    const remaining = await store.list('s1')
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).toBe('s1-2')
  })

  it('returns exit 1 when the id is unknown', async () => {
    const code = await checkpointDeleteCommand({ id: 'missing', store })
    expect(code).toBe(1)
    expect(stderr).toContain('no checkpoint with id "missing"')
  })
})
