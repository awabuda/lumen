---
"@lumen/cli": minor
---

P57 — when the TUI mounts and the P32.2
checkpoint path returns undefined (the typical
case: the previous session was a `success` or
`error` outcome, so the in-progress checkpoint
was cleared), the TUI now seeds its `turns`
state from the `session_messages` history.

Pre-P57 the TUI only restored the most-recent
in-progress checkpoint (P32.2), so a user who
closed the TUI after a successful `success` /
`error` event would reopen `lumen chat` to an
empty log even though every prior turn was
sitting in `session_messages`. P57 fetches the
full message history via
`getSessionMessages(sessionId)` and converts
them to the same `Turn` shape the P32.2 effect
uses.

P57 also adds `memoryStore` to ChatProps and
threads the same SqliteStore instance the
agent writes to through `chat.tsx` so the TUI
can read prior conversation messages on mount.
The agent's `persistMessage` method (P10.2) was
already writing to `session_messages` on every
turn — the data was always on disk; the TUI was
simply looking at the wrong table.

Test counts: cli 460 → 461 (+1 new, 0 new
pre-existing FENCE-OFF).
