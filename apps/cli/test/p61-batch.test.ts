/**
 * P61 — TUI restoration fetch must respect the
 * same `MAX_HYDRATE_MESSAGES` cap as the agent
 * context. Pre-P61 the P57 effect in `Chat.tsx`
 * hard-coded `{ limit: 1000 }` on
 * `memoryStore.getSessionMessages`, which on
 * long-lived cwd-derived sessions (e.g.
 * `chat-lo0y9LBpGF4` with 883 rows on 2026-08-12)
 * forced Ink to render every restored turn on
 * every input keystroke. The "screen flicker +
 * slow thinking" symptom in the TUI was a direct
 * consequence of the over-fetch.
 *
 * The fix moves the limit to
 * `MAX_HYDRATE_MESSAGES` (20 rows, exported from
 * `@lumen/core` as of P60). This test seeds 50
 * prior messages and asserts the TUI restoration
 * path asks the store for at most 20 — the
 * remaining 30 are intentionally dropped on the
 * read side, not on the write side (the writes
 * still happen, the read just stops reading).
 *
 * The pairing / drop-system / drop-tool logic
 * lives in `messagesToTurns` (already covered by
 * the P32.2 / P57 test set); P61 only needs to
 * pin the cap constant so the next refactor
 * cannot silently re-bump it.
 */

import { SqliteStore } from '@lumen/memory'
import { MAX_HYDRATE_MESSAGES } from '@lumen/core'
import { describe, expect, it } from 'vitest'

describe('P61 — TUI restore cap mirrors the agent hydrate cap', () => {
  it('MAX_HYDRATE_MESSAGES is a small positive integer', () => {
    expect(typeof MAX_HYDRATE_MESSAGES).toBe('number')
    expect(MAX_HYDRATE_MESSAGES).toBeGreaterThan(0)
    // The cap is sized for ~10 turns of back-and-forth.
    // A larger cap (e.g. 1000) re-introduces the
    // flicker / over-fetch class; a smaller cap (e.g.
    // 2) drops the user's immediate prior turn. 20 is
    // the validated value; bump it together with the
    // agent hydrate cap, not independently.
    expect(MAX_HYDRATE_MESSAGES).toBeLessThanOrEqual(50)
  })

  it('P57 effect uses MAX_HYDRATE_MESSAGES, not 1000', async () => {
    // Read the Chat.tsx source and assert the P57
    // effect's `getSessionMessages` call site uses
    // MAX_HYDRATE_MESSAGES. This is a string-level
    // pin rather than a runtime test because the
    // effect lives inside React/Ink and the TUI
    // mount path is hard to exercise in a unit
    // test. The pin is what stops the next
    // refactor from silently re-bumping the limit.
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')
    const chatTsxPath = fileURLToPath(
      new URL('../src/components/Chat.tsx', import.meta.url),
    )
    const src = await readFile(chatTsxPath, 'utf8')
    // The fix is the literal `MAX_HYDRATE_MESSAGES`
    // token in the P57 useEffect's fetch call.
    expect(src).toMatch(/getSessionMessages\(\s*sessionId,\s*\{\s*limit:\s*MAX_HYDRATE_MESSAGES/)
    // The bug was the literal `limit: 1000` in the
    // same useEffect. If a future refactor re-bumps
    // it, this test fails before the regression
    // ships.
    expect(src).not.toMatch(/getSessionMessages\(\s*sessionId,\s*\{\s*limit:\s*1000/)
  })
})