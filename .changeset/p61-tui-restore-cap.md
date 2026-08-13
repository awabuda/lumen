---
"@lumen/cli": minor
"@lumen/core": minor
---

P61 — `lumen chat` TUI restoration now respects
the same `MAX_HYDRATE_MESSAGES` sliding-window
cap as the agent context (P60). Pre-P61 the P57
effect in `Chat.tsx` hard-coded `{ limit: 1000 }`
on `memoryStore.getSessionMessages`, which on
long-lived cwd-derived sessions (e.g.
`chat-lo0y9LBpGF4` with 883 rows on 2026-08-12)
forced Ink to render every restored turn on
every input keystroke. The visible symptom was
a "screen flicker + slow thinking" feedback
loop: each typed character re-rendered ~440
turns of chat history, the input box repaint
raced the scrollback repaint, and the user's eye
saw the flicker. P61 caps the restore fetch to
20 rows, so the TUI now mounts and re-renders
at the same speed as a fresh `lumen chat`.

P61 also collapses the inline 40-line
`messagesToTurns` re-derivation in the P57
effect in favour of the shared
`messagesToTurns` helper that the P32.2
checkpoint path already uses. The inline copy
had silently drifted from the shared helper on
edge cases (e.g. mid-stream assistant without a
preceding user); the P61 adapter goes through
the same code path, so the two restoration
surfaces (P32.2 checkpoint + P57
session_messages) cannot diverge again. The
adapter lives as a top-level pure function in
`Chat.tsx` (`sessionMessageToAgentMessage`) so
the TUI render layer stays one-line thin and
the conversion is unit-testable.

The `MAX_HYDRATE_MESSAGES` constant is now
re-exported from `@lumen/core`'s top-level
`index.ts` so the CLI can import it without
diving into the `agent/` subpath. Pinned by
`apps/cli/test/p61-batch.test.ts` (2 unit
tests: the constant's value range + a
string-level pin on the P57 useEffect call
site).

After P60 + P61, `chat-lo0y9LBpGF4` (the
operator's primary cwd-derived session):
- agent context: bounded to the most-recent 20
  session_messages rows (P60, v0.56.0)
- TUI restore: bounded to the same 20 rows
  (P61, v0.57.0)
- the agent no longer says "this is the first
  message" when the user types "你好,你是谁?"
  (P60 fixed the loop) and the TUI no longer
  flickers on every keystroke (P61 fixed the
  over-fetch)

Caveat: the writes (every turn the operator
types still appends to `session_messages` via
`Agent.persistMessage`) are unchanged. The cap
is a **read** cap, not a **write** cap — the
full history is still on disk; only the
agent's prompt window and the TUI's render
window are bounded. Operators who need the
full 883-row history for a downstream task
(e.g. `lumen session show <id> --limit
unbounded`) can still reach it through the
CLI surface; the P60/P61 cap only affects the
in-conversation restoration path.