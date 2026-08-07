/**
 * P59 — `lumen chat` session-id fallback.
 *
 * Pre-P59 the chat command always used a
 * cwd-derived session id (`chat-<sha256>`). If
 * the cwd hash changed (e.g. a different
 * invocation path, a different `path.resolve`
 * normalisation, or a manual `--session-id`
 * override that landed before P32.1), the
 * operator's existing session was orphaned —
 * every `lumen chat` re-launch created a fresh
 * session, the chat log rendered empty, and the
 * agent said "this is the first message" even
 * though prior turns had landed in
 * `session_messages`.
 *
 * P59 keeps the cwd-derived default for new
 * installs but adds a fallback: if no session
 * with the cwd-derived id exists in the
 * SqliteStore, `resolveChatSessionId` falls back
 * to the most recent session so the operator's
 * prior conversation is preserved.
 *
 * Two tests exercise the path:
 *   1. cwd-derived id matches → use it.
 *   2. cwd-derived id is missing → fall back to
 *      the most recent session.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveChatSessionId } from '../src/chat-paths.js'

let tmpDir: string
let store: SqliteStore | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p59-'))
})

afterEach(async () => {
  await store?.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('P59 — lumen chat session-id fallback', () => {
  it('uses the cwd-derived id when a session with that id exists', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    store = new SqliteStore({ path: dbPath })
    await store.init()
    // Seed one session with the cwd-derived id.
    const cwd = '/Users/chengpengtao/workspace/lumen'
    const { defaultChatSessionId } = await import('../src/chat-paths.js')
    const cwdDerived = defaultChatSessionId(cwd)
    await store.createSession({ id: cwdDerived, title: 'cwd-derived' })
    // Second session, more recent.
    await store.createSession({ id: 'other-recent', title: 'other' })

    const resolved = await resolveChatSessionId({ store, cwd })
    // P59 — cwd-derived id wins because it exists.
    expect(resolved).toBe(cwdDerived)
  })

  it('falls back to the most recent session when no cwd-derived match exists', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    store = new SqliteStore({ path: dbPath })
    await store.init()
    // Seed two sessions, neither matching the
    // cwd-derived id. The first one (`old`) is
    // older; `recent` is newer.
    const cwd = '/Users/chengpengtao/workspace/lumen'
    await store.createSession({ id: 'chat-old', title: 'old' })
    await store.createSession({ id: 'chat-recent', title: 'recent' })

    const resolved = await resolveChatSessionId({ store, cwd })
    // P59 — falls back to the most recent session.
    // `listSessions` is documented as `ORDER BY
    // updated_at DESC`, so the most recent
    // session is at index 0.
    expect(resolved).toBe('chat-recent')
  })

  it('returns the cwd-derived id when no sessions exist', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    store = new SqliteStore({ path: dbPath })
    await store.init()
    const cwd = '/Users/chengpengtao/workspace/lumen'
    const { defaultChatSessionId } = await import('../src/chat-paths.js')
    const cwdDerived = defaultChatSessionId(cwd)

    const resolved = await resolveChatSessionId({ store, cwd })
    expect(resolved).toBe(cwdDerived)
  })
})
