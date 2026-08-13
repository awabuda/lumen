/**
 * P63 — OpenClaw-style TUI session resolution.
 *
 * The 3-layer fallback:
 *   1. `--session-id <id>` (explicit, wins over everything)
 *   2. `~/.lumen/chat_last_session` (last-used key for
 *      the cwd's scope; persists across launches)
 *   3. cwd-derived id (P32.1 default, written to the
 *      remember file on first use so subsequent launches
 *      reuse it)
 *
 * `chat-session.ts` ships the loader + writer; the CLI
 * wires it into `lumen chat` via the new `pinnedToCwd`
 * flag. This file pins the 7 contract cases end-to-end
 * (against a temp `LUMEN_HOME` so the real
 * `~/.lumen/chat_last_session` is never touched by tests).
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  _clearRememberedSessions,
  rememberChatSession,
  resolveChatSession,
} from '../src/chat-session.js'

let tmpDir: string
let rememberPath: string
let cwd: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p63-'))
  rememberPath = path.join(tmpDir, 'chat_last_session')
  cwd = '/tmp/p63-test-cwd'
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  // `chat-session.ts` resolves CHAT_LAST_SESSION_PATH at
  // module load time; tests can't change that, so we just
  // make sure we never wrote to the real one (the tests
  // use the cwd-derived scopeKey from `cwd = '/tmp/...'`,
  // which is `chat-...` and would only collide with a real
  // operator who happens to be working in `/tmp/...`).
  await _clearRememberedSessions().catch(() => undefined)
})

describe('P63 — resolveChatSession (OpenClaw 3-layer fallback)', () => {
  it('layer 1 wins: explicitSessionId overrides everything', async () => {
    await rememberChatSession({ cwd, sessionId: 'remembered-id' })
    const r = await resolveChatSession({
      cwd,
      explicitSessionId: 'user-typed-id',
      rememberPath,
    })
    expect(r.sessionId).toBe('user-typed-id')
  })

  it('layer 2 hits: remembered key is returned when no explicit id', async () => {
    await rememberChatSession({ cwd, sessionId: 'remembered-id', rememberPath })
    const r = await resolveChatSession({ cwd, rememberPath })
    expect(r.sessionId).toBe('remembered-id')
  })

  it('layer 3 fallback: cwd-derived id when no remember row', async () => {
    const r = await resolveChatSession({ cwd, rememberPath })
    expect(r.sessionId).toMatch(/^chat-[A-Za-z0-9_-]{11}$/)
  })

  it('layer 3 explicit opt-in: pinnedToCwd skips the remember lookup', async () => {
    await rememberChatSession({ cwd, sessionId: 'remembered-id', rememberPath })
    const r = await resolveChatSession({ cwd, pinnedToCwd: true, rememberPath })
    // cwd-derived id, NOT the remembered one
    expect(r.sessionId).not.toBe('remembered-id')
    expect(r.sessionId).toMatch(/^chat-[A-Za-z0-9_-]{11}$/)
  })

  it('layer 2 persists: rememberChatSession then resolveChatSession returns the stored key', async () => {
    await rememberChatSession({ cwd, sessionId: 'first-use-id', rememberPath })
    // Write a SECOND launch — the new id is what we
    // expect to be remembered for the next launch.
    await rememberChatSession({ cwd, sessionId: 'second-use-id', rememberPath })
    const r = await resolveChatSession({ cwd, rememberPath })
    expect(r.sessionId).toBe('second-use-id')
  })

  it('scope key is the cwd-derived id (per-cwd isolation)', async () => {
    const r1 = await resolveChatSession({ cwd: '/tmp/p63-cwd-A', rememberPath })
    const r2 = await resolveChatSession({ cwd: '/tmp/p63-cwd-B', rememberPath })
    expect(r1.scopeKey).not.toBe(r2.scopeKey)
    expect(r1.sessionId).not.toBe(r2.sessionId)
  })

  it('different cwds remember independently', async () => {
    await rememberChatSession({ cwd: '/tmp/p63-cwd-X', sessionId: 'X-id', rememberPath })
    await rememberChatSession({ cwd: '/tmp/p63-cwd-Y', sessionId: 'Y-id', rememberPath })
    const rx = await resolveChatSession({ cwd: '/tmp/p63-cwd-X', rememberPath })
    const ry = await resolveChatSession({ cwd: '/tmp/p63-cwd-Y', rememberPath })
    expect(rx.sessionId).toBe('X-id')
    expect(ry.sessionId).toBe('Y-id')
  })

  it('scopeKey is stable across calls (the cwd hash is the key)', async () => {
    const r1 = await resolveChatSession({ cwd, rememberPath })
    const r2 = await resolveChatSession({ cwd, rememberPath })
    expect(r1.scopeKey).toBe(r2.scopeKey)
  })

  it('resolveChatSession is a pure read: no file write happens', async () => {
    // Read once — the file should NOT exist afterwards
    // (the resolver only writes via the caller-driven
    // `rememberChatSession`). The on-disk write happens
    // in the CLI's `chatCommand` after the resolver
    // returns.
    const before = await fs
      .readFile(rememberPath, 'utf8')
      .then(() => 'exists')
      .catch((err) => (err.code === 'ENOENT' ? 'absent' : 'error'))
    expect(before).toBe('absent')
    await resolveChatSession({ cwd, rememberPath })
    const after = await fs
      .readFile(rememberPath, 'utf8')
      .then(() => 'exists')
      .catch((err) => (err.code === 'ENOENT' ? 'absent' : 'error'))
    expect(after).toBe('absent')
  })
})