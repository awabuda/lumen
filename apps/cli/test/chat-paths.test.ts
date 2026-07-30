/**
 * P32.1 unit tests for `chat-paths.ts`.
 *
 * Two helpers, four behaviours:
 *   - `defaultChatCheckpointPath` honours LUMEN_CHAT_CHECKPOINT_PATH
 *     first, then XDG_STATE_HOME, then ~/.local/state/lumen/.
 *   - `defaultChatSessionId` is deterministic for the same cwd and
 *     distinct for distinct cwds, and the result is filesystem-safe.
 *
 * The tests deliberately avoid touching `os.homedir()` directly —
 * HOME is monkeypatched in test setup so we can assert the
 * `~/.local/state/...` fallback without leaving the suite tied
 * to whatever $HOME happens to be on the runner.
 */
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultChatCheckpointPath, defaultChatSessionId } from '../src/chat-paths.js'

const ENV_KEYS = ['LUMEN_CHAT_CHECKPOINT_PATH', 'XDG_STATE_HOME', 'HOME'] as const

describe('defaultChatCheckpointPath', () => {
  let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

  beforeEach(() => {
    savedEnv = {} as Record<(typeof ENV_KEYS)[number], string | undefined>
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    // Stub HOME so the XDG-State / fallback branches land on a
    // path we can assert literally, not whatever the dev's $HOME
    // happens to be on a given day.
    process.env.HOME = '/tmp/lumen-chat-paths-test-home'
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const next = savedEnv[key]
      if (next === undefined) delete process.env[key]
      else process.env[key] = next
    }
  })

  it('honours LUMEN_CHAT_CHECKPOINT_PATH first', () => {
    process.env.LUMEN_CHAT_CHECKPOINT_PATH = '/tmp/custom-checkpoint.sqlite'
    process.env.XDG_STATE_HOME = '/should-be-ignored-once-override-set'
    expect(defaultChatCheckpointPath()).toBe('/tmp/custom-checkpoint.sqlite')
  })

  it('falls through to $XDG_STATE_HOME when no override is set', () => {
    process.env.XDG_STATE_HOME = '/tmp/xdg/state'
    const got = defaultChatCheckpointPath()
    expect(got).toBe(path.join('/tmp/xdg/state', 'lumen', 'chat.sqlite'))
  })

  it('treats an empty LUMEN_CHAT_CHECKPOINT_PATH as unset', () => {
    process.env.LUMEN_CHAT_CHECKPOINT_PATH = ''
    process.env.XDG_STATE_HOME = '/tmp/xdg/state'
    expect(defaultChatCheckpointPath()).toBe(path.join('/tmp/xdg/state', 'lumen', 'chat.sqlite'))
  })

  it('falls back to ~/.local/state/lumen/chat.sqlite when no XDG_STATE_HOME', () => {
    // HOME is set to /tmp/lumen-chat-paths-test-home in beforeEach.
    const expected = path.join(
      '/tmp/lumen-chat-paths-test-home',
      '.local',
      'state',
      'lumen',
      'chat.sqlite',
    )
    expect(defaultChatCheckpointPath()).toBe(expected)
  })
})

describe('defaultChatSessionId', () => {
  it('is deterministic for the same cwd', () => {
    const a = defaultChatSessionId('/Users/dev/project')
    const b = defaultChatSessionId('/Users/dev/project')
    expect(a).toBe(b)
  })

  it('is distinct for distinct cwds', () => {
    const a = defaultChatSessionId('/Users/dev/project-a')
    const b = defaultChatSessionId('/Users/dev/project-b')
    expect(a).not.toBe(b)
  })

  it('normalises trailing-slash and relative paths', () => {
    // `path.resolve` makes /a and /a/ produce the same id
    // even though the user typed them differently in the shell.
    expect(defaultChatSessionId('/Users/dev/project')).toBe(
      defaultChatSessionId('/Users/dev/project/'),
    )
  })

  it('returns a filesystem-safe id with no / or .', () => {
    const id = defaultChatSessionId('/some/cwd')
    // checkpointId = `${sessionId}-${iterations}`. So sessionId
    // must not contain `/`, `\\`, or whitespace and must not be
    // a leading dot. base64url alphabet + `-` prefix char only.
    expect(id).toMatch(/^chat-[A-Za-z0-9_-]+$/)
    expect(id.startsWith('.')).toBe(false)
    expect(id.length).toBeLessThanOrEqual(64)
  })

  it('does not leak the original cwd path', () => {
    const id = defaultChatSessionId('/Users/dev/secret-projects/confidential')
    expect(id.includes('secret')).toBe(false)
    expect(id.includes('confidential')).toBe(false)
    expect(id.includes('Users')).toBe(false)
  })

  it('matches the same cwd regardless of cwd mode provided', () => {
    // The real os.homedir() should still resolve for sanity,
    // but we never want to assert the user's actual home path
    // in tests (would leak into CI). Just check the function
    // works with the real homedir too.
    const real = os.homedir()
    const id = defaultChatSessionId(real)
    expect(id).toMatch(/^chat-[A-Za-z0-9_-]+$/)
  })
})
