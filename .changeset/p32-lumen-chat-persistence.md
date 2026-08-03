---
'@lumen/cli': minor
'@lumen/core': minor
'@lumen/memory': minor
'@lumen/tools': minor
---

P32 — `lumen chat` persistence + session registry + cron durability.

7 commits across `apps/cli/src/chat-paths.ts` (XDG-aware path
resolution + 8-byte-base64url cwd hash → `chat-<hash>` session id
deterministic for the same cwd), `apps/cli/src/components/restore-turns.ts`
(mount-time history render via `messagesToTurns` helper with 4 rules),
the new `BaseCheckpointStore.listSessions` / `deleteSession` interface
extension (SQLite + InMemory both implement), the `lumen chat`
TUI `/sessions` slash command (`list` / `list N` / `show <id>` /
`switch <id>` [restart-required via `chat-next-session.json` + relaunch
with `--session-id`] / `delete <id>` [refuses the active session]),
`packages/memory/src/sqlite-loops-store.ts` (`SqliteLoopsStore`
persists every `/loop` registration; `reloadPersistedLoops()` on
TUI mount re-arms every `stopped_at IS NULL` row), and the
`apps/cli/src/native-abi.ts` (`probeBetterSqlite3Abi` — `lumen doctor`
now reports `[OK]` / `[FAIL]` better-sqlite3 ABI drift instead of an
opaque `NODE_MODULE_VERSION` driver throw).

Three new `lumen chat` flags (`--session-id <id>` override,
`--new-session` force a fresh uuid, `--no-persist` opt back into
the pre-P32 in-memory behaviour) and the `lumen doctor --product`
opt-in flag for the P33.A G-P1..G-P6 product gates.

The pre-P32 `Cannot open database because the directory does not
exist` regression from a fresh install at
`$XDG_STATE_HOME/lumen/chat.sqlite` is fixed in `38ca9d1` by
`mkdirSync(parent, {recursive: true})` in the SqliteCheckpointStore
+ SqliteStore constructors.

Refs: TASKS.md §P32; `lumen docs/OPTIMIZATION-PLAN.md` (strategic
positioning + Day1-Day5 budget for the G-P1..G-P6 follow-up).
