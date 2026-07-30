/**
 * P32.3 unit tests for `handleSessionsSlash`.
 *
 * The handler is a thin orchestrator over `BaseCheckpointStore.listSessions`
 * (validated in `packages/memory/test/checkpoint-sessions.test.ts`
 * and `packages/core/test/checkpoint-sessions.test.ts`). These tests
 * pin the slash-command UX layer: argument parsing, the active-row
 * marker, the queue-on-switch path, and the safety guard that
 * refuses to delete the currently-running session.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentCheckpoint } from '@lumen/core'
import { InMemoryCheckpointStore } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type SessionsSlashContext, handleSessionsSlash } from '../src/components/sessions-slash.js'

let tmpDir: string
let nextSessionPath: string
let store: InMemoryCheckpointStore
let ctx: SessionsSlashContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-sessions-slash-'))
  nextSessionPath = path.join(tmpDir, NEXT_SESSION_FILE_NAME)
  store = new InMemoryCheckpointStore()
  ctx = {
    checkpointStore: store,
    nextSessionPath,
  }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const NEXT_SESSION_FILE_NAME = 'chat-next-session.json'

const cp = (overrides: Partial<AgentCheckpoint> = {}): AgentCheckpoint => ({
  id: 's1-1',
  sessionId: 's1',
  iterations: 1,
  createdAt: 1_000,
  outcome: 'success',
  messages: [],
  ...overrides,
})

describe('handleSessionsSlash — list', () => {
  it('reports empty state when there are no sessions', async () => {
    const result = await handleSessionsSlash('/sessions', ctx)
    expect(result.message).toContain('no stored sessions yet')
    expect(result.queuedSessionId).toBeUndefined()
  })

  it('renders one line per session, newest first', async () => {
    await store.save(cp({ id: 'a-1', sessionId: 'alpha', createdAt: 1_000 }))
    await store.save(cp({ id: 'b-1', sessionId: 'bravo', createdAt: 5_000 }))
    const result = await handleSessionsSlash('/sessions', ctx)
    const lines = result.message.split('\n')
    expect(lines[0]).toContain('recent conversations')
    // Most recent first → bravo before alpha
    const bravoIdx = lines.findIndex((l) => l.includes('bravo'))
    const alphaIdx = lines.findIndex((l) => l.includes('alpha'))
    expect(bravoIdx).toBeGreaterThan(0)
    expect(alphaIdx).toBeGreaterThan(0)
    expect(bravoIdx).toBeLessThan(alphaIdx)
  })

  it('marks the current session with a left-arrow indicator', async () => {
    await store.save(cp({ id: 'a', sessionId: 'alpha', createdAt: 1_000 }))
    await store.save(cp({ id: 'b', sessionId: 'bravo', createdAt: 2_000 }))
    const result = await handleSessionsSlash('/sessions', {
      ...ctx,
      currentSessionId: 'bravo',
    })
    const lines = result.message.split('\n')
    const bravoLine = lines.find((l) => l.includes('bravo'))
    const alphaLine = lines.find((l) => l.includes('alpha'))
    expect(bravoLine?.startsWith('←')).toBe(true)
    expect(alphaLine?.startsWith('  ')).toBe(true)
  })

  it('honours an explicit /sessions list 1', async () => {
    await store.save(cp({ id: 'a', sessionId: 'alpha', createdAt: 1_000 }))
    await store.save(cp({ id: 'b', sessionId: 'bravo', createdAt: 2_000 }))
    await store.save(cp({ id: 'c', sessionId: 'charlie', createdAt: 3_000 }))
    const result = await handleSessionsSlash('/sessions list 1', ctx)
    const lines = result.message.split('\n').filter((l) => l.includes('  '))
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('charlie')
  })

  it('rejects a non-positive integer limit', async () => {
    const result = await handleSessionsSlash('/sessions list 0', ctx)
    expect(result.message).toContain('positive integer')
  })
})

describe('handleSessionsSlash — show', () => {
  it('rejects missing id', async () => {
    const result = await handleSessionsSlash('/sessions show', ctx)
    expect(result.message).toContain('id required')
  })

  it('rejects unknown session id', async () => {
    const result = await handleSessionsSlash('/sessions show ghost', ctx)
    expect(result.message).toContain('no such session')
  })

  it('renders a one-line summary for a known session', async () => {
    await store.save(cp({ id: 's', sessionId: 'real', createdAt: 4_242 }))
    const result = await handleSessionsSlash('/sessions show real', ctx)
    expect(result.message).toContain('real')
    expect(result.message).toContain('checkpoints: 1')
  })
})

describe('handleSessionsSlash — switch', () => {
  it('rejects missing id', async () => {
    const result = await handleSessionsSlash('/sessions switch', ctx)
    expect(result.message).toContain('id required')
  })

  it('refuses when target is already the current session', async () => {
    const result = await handleSessionsSlash('/sessions switch here', {
      ...ctx,
      currentSessionId: 'here',
    })
    expect(result.message).toContain('already in')
  })

  it('writes the next-session queue file and reports success', async () => {
    const result = await handleSessionsSlash('/sessions switch other', ctx)
    expect(result.queuedSessionId).toBe('other')
    expect(result.message).toContain('queued')
    expect(result.message).toContain('lumen chat --session-id other')
    const written = JSON.parse(await fs.readFile(nextSessionPath, 'utf8'))
    expect(written.sessionId).toBe('other')
    expect(typeof written.queuedAt).toBe('number')
  })

  it('creates the parent directory if missing', async () => {
    // Override path with a path inside a fresh subdir to verify mkdirSync.
    const nested = path.join(tmpDir, 'a', 'b', NEXT_SESSION_FILE_NAME)
    const nestedCtx = { ...ctx, nextSessionPath: nested }
    await handleSessionsSlash('/sessions switch another', nestedCtx)
    expect(JSON.parse(await fs.readFile(nested, 'utf8')).sessionId).toBe('another')
  })
})

describe('handleSessionsSlash — delete', () => {
  it('refuses to delete the running session', async () => {
    await store.save(cp({ id: 'live', sessionId: 'running' }))
    const result = await handleSessionsSlash('/sessions delete running', {
      ...ctx,
      currentSessionId: 'running',
    })
    expect(result.message).toContain('refuse')
    // Session is still present
    const summaries = await store.listSessions()
    expect(summaries.map((s) => s.sessionId)).toEqual(['running'])
  })

  it('deletes a non-running session and reports the row count', async () => {
    await store.save(cp({ id: 'a-1', sessionId: 'a' }))
    await store.save(cp({ id: 'a-2', sessionId: 'a' }))
    await store.save(cp({ id: 'b-1', sessionId: 'b' }))
    const result = await handleSessionsSlash('/sessions delete a', ctx)
    expect(result.message).toContain('removed 2')
    const summaries = await store.listSessions()
    expect(summaries.map((s) => s.sessionId)).toEqual(['b'])
  })

  it('reports when the session had no checkpoints', async () => {
    const result = await handleSessionsSlash('/sessions delete absent', ctx)
    expect(result.message).toContain('no checkpoints under')
  })
})

describe('handleSessionsSlash — help / unknown', () => {
  it('prints help when /sessions help is requested', async () => {
    const result = await handleSessionsSlash('/sessions help', ctx)
    expect(result.message).toContain('commands:')
    expect(result.message).toContain('switch <id>')
  })

  it('rejects unknown sub-commands with help text', async () => {
    const result = await handleSessionsSlash('/sessions frobnicate', ctx)
    expect(result.message).toContain('unknown sub-command')
    expect(result.message).toContain('commands:')
  })
})
