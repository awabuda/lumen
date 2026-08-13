---
"@lumen/cli": minor
---

P63 — `lumen chat` now defaults to the OpenClaw-style
`remember-last-used` session resolution pattern
(`tui_last_sessions` table in
`~/workspace/openclaw-main/src/tui/tui-last-session.ts`,
mirrored in `~/.lumen/chat_last_session` as a flat JSON
file). The 3-layer fallback is:

1. `--session-id <id>` (explicit, wins over
   everything) — unchanged from P32.1
2. `~/.lumen/chat_last_session` (last-used key for
   the cwd's scope; persists across launches) —
   NEW in P63
3. cwd-derived id (P32.1 default, written to the
   remember file on first use) — unchanged

The opt-in flag `--pinned-to-cwd` restores the
pre-P63 cwd-pinned behaviour (skip the remember
lookup AND skip the remember write so a single
cwd-pinned launch does not pollute the operator's
other cwd launches).

## Why

P32.1's `defaultChatSessionId(cwd)` returned the
same id every launch in the same cwd. The hidden
cost: every blank-session request required
`--new-session`, and the P59 fallback to "most
recent session" actually made the surprise worse
— on a long-lived machine the "most recent
session" was usually a session the operator had
forgotten about. P63 fixes the underlying
contract: the session id is **remembered** per-scope
(not derived from cwd), and the operator controls
which session is remembered by typing
`--session-id <id>` or `--new-session` on the
launch where the change matters.

## What stays the same

- `--session-id` still wins over everything
  (unchanged)
- `--new-session` still skips the remember lookup
  AND skips the remember write (operator opted
  out of remembering for this launch)
- `--no-persist` still opts out of the whole
  persistence surface (unchanged)
- P59's SqliteStore-based fallback
  (`resolveChatSessionId`) is preserved as a
  safety net: if the P63-remembered key has no
  matching row in the SqliteStore (e.g. a fresh
  install where the operator never created a
  session in this cwd), the resolver falls
  through to the most-recent session.

## How the migration looks for existing operators

- Pre-P63 cwd-derived session
  `chat-lo0y9LBpGF4` (your `~/workspace/lumen`):
  on the FIRST `lumen chat` post-upgrade, the
  P59 safety net hits (cwd-derived key has no
  matching row in the SqliteStore because the
  P59 fallback already migrated you to
  most-recent), the remember file is written
  with the chosen key, and subsequent launches
  reuse it. To restore the pre-P63 cwd-pinned
  behaviour explicitly, pass `--pinned-to-cwd`
  on every launch.
- Operators with no `chat_last_session` file
  yet: the very first `lumen chat` after upgrade
  lands on the cwd-derived key (layer 3), then
  writes that key to the remember file. The
  behaviour is identical to P32.1 until the
  operator runs `--new-session` or
  `--session-id <something>`.

## On-disk shape

`~/.lumen/chat_last_session` is a flat JSON
object: `{"<scopeKey>": "<sessionId>"}`. One
row per cwd-derived scope key (8 bytes
base64url). Concurrent `lumen chat` processes
race on the file; last-writer-wins (same
behaviour as OpenClaw's `writeTuiLastSessionKey`).

## Verification

- `pnpm --filter @lumen/cli exec vitest run
  test/p63-batch.test.ts` — 9 / 9 pass
  (3-layer fallback for 4 cases + per-cwd
  isolation + 2 write/read round-trips + pure-read
  resolver invariant + scopeKey stability)
- 485 / 497 cli tests pass (3 pre-existing P54
  baseline fence-off fails unrelated)
- `pnpm --filter @lumen/cli typecheck` clean
- `pnpm --filter @lumen/cli build` → dist
  2026-08-13 17:07
- End-to-end: a direct node call to
  `resolveChatSession` returns cwd-derived on
  first call, returns the remembered key on
  second call (after `rememberChatSession`),
  and returns cwd-derived again on
  `pinnedToCwd: true` (skipping the
  remembered entry).