/**
 * P57 — when the TUI mounts and the P32.2
 * checkpoint path returns undefined (the typical
 * case: the previous session was a `success` or
 * `error` outcome, so the in-progress checkpoint
 * was cleared), the TUI must seed its `turns`
 * state from the `session_messages` history.
 *
 * Pre-P57 the TUI only restored the most-recent
 * in-progress checkpoint (P32.2), so a user who
 * closed the TUI after a successful `success` /
 * `error` event would reopen `lumen chat` to an
 * empty log even though every prior turn was
 * sitting in `session_messages`. P57 fetches the
 * full message history via `getSessionMessages`
 * and converts them to the same `Turn` shape the
 * P32.2 effect uses.
 *
 * One test exercises the path: write 4 messages
 * to the store (1 system + 1 user + 1 assistant
 * + 1 user), confirm the user can read the
 * message history back through the same
 * `getSessionMessages` API the TUI effect uses.
 * The actual TUI rendering is verified
 * end-to-end in `lumen memory show` (P56
 * related) — the unit test here is a thin
 * contract test for the store surface.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let tmpDir: string
let store: SqliteStore | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p57-'))
})

afterEach(async () => {
  await store?.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('P57 — lumen chat session-message history (fallback path)', () => {
  it('exposes the full prior conversation through getSessionMessages', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    store = new SqliteStore({ path: dbPath })
    await store.init()
    // P57 — the TUI effect (apps/cli/src/components/Chat.tsx
    // useEffect around line 130) calls
    // `memoryStore.getSessionMessages(sessionId, { limit: 1000 })`
    // to fetch the prior conversation. This unit
    // test exercises the same store surface.
    // The `SessionRecord` shape requires `id` (the
    // store uses the caller's id rather than
    // generating one — session creation is
    // externally controlled; see P32.1's
    // cwd-derived stable id).
    const session = await store.createSession({ id: 'p57-test', title: 'p57-test' })
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'hi' })
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'hello',
    })
    await store.appendMessage({ sessionId: session.id, role: 'user', content: 'how are you?' })
    await store.appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'fine, thanks',
      toolName: 'echo',
    })

    const messages = await store.getSessionMessages(session.id, { limit: 1000 })
    expect(messages.length).toBe(4)
    // The store returns messages in chronological
    // order. The TUI's P57 effect pairs them into
    // (user, assistant) turns; this unit test only
    // asserts that the store surface returns the
    // full history (the pairing is exercised at
    // the TUI layer, not here).
    expect(messages[0]?.role).toBe('user')
    expect(messages[0]?.content).toBe('hi')
    expect(messages[1]?.role).toBe('assistant')
    expect(messages[1]?.content).toBe('hello')
    expect(messages[3]?.role).toBe('assistant')
    expect(messages[3]?.content).toBe('fine, thanks')
    expect(messages[3]?.toolName).toBe('echo')
  })
})
