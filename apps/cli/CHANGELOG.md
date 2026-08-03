# @lumen/cli

## 0.18.0

### Minor Changes

- 3211dcc: P32 — `lumen chat` persistence + session registry + cron durability.

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

  - SqliteStore constructors.

  Refs: TASKS.md §P32; `lumen docs/OPTIMIZATION-PLAN.md` (strategic
  positioning + Day1-Day5 budget for the G-P1..G-P6 follow-up).

- 3211dcc: P33.A — `lumen doctor --product` product-gate diagnostic surface.

  Adds a new opt-in `--product` flag to `lumen doctor` that runs
  G-P1..G-P6 product-completeness gates from
  `docs/OPTIMIZATION-PLAN.md` §0.5 after the existing 10 infrastructure
  checks. Each gate emits one `[OK] / [WARN] / [FAIL]` row so a CI
  gate can grep the output. Product FAIL rows do NOT bump the doctor
  exit code (they are informational, mirroring the WARN path); only
  infrastructure FAIL rows do.

  `apps/cli/src/product-gates.ts` exports 6 pure helpers
  (`gateG_P1_openBoxUsability` … `gateG_P6_profileBare`) plus a
  `runAllGates` aggregator. Each helper returns
  `{ gate, severity: 'OK'|'WARN'|'FAIL', message, hint }` —
  severity model follows the L1-AUDIT "honest diagnostic" rule:
  FAIL rather than OK when the dependency is shipped but the UX
  still needs polish, so the FAIL rows remain visible. Today the
  G-P1 / G-P6 gates ship FAIL (the FS workspaceRoot + ToolRisk
  dispatch + default-middleware-order work is the P33.B+ sweep, see
  `docs/OPTIMIZATION-PLAN.md` §7 Day1-Day5).

  `apps/cli/src/commands/doctor.ts` lazy-imports
  `product-gates.js` only when `--product` is passed; the existing
  `doctor` call sites remain zero-cost.

  9 vitest cases in `apps/cli/test/product-gates.test.ts` pin the
  severity-membership contract + the `runAllGates` ordering.

  Refs: TASKS.md §P33.A; `docs/OPTIMIZATION-PLAN.md` §0.5 / §7.

### Patch Changes

- Updated dependencies [3211dcc]
  - @lumen/core@0.18.0
  - @lumen/memory@0.18.0
  - @lumen/tools@0.17.0
  - @lumen/llm@0.16.1
  - @lumen/mcp@0.16.1

## 0.17.0

### Minor Changes

- 6cab11f: P23.12 — wires bug.md #64 / #69 / #70 / #71 end-to-end:

  - `Budget.tokensConsumed` / `.costUsdConsumed` / `.timeMsConsumed` (and a `used` getter alias) surface single-value counters the `/cost` slash command reads. Pure additions; every existing `Budget.snapshot()` call site is unaffected.
  - `Agent.budgetSnapshot()` returns the most recently completed `Budget` from the agent loop; wired by `executeLoop` to `this.lastBudget = budget` so the value survives across calls.
  - `DuckDuckGoSearchProvider.parse` replaces the pre-P23.12 mega-regex with a real streaming tokenizer (`packages/tools/src/web/html-tokenizer.ts`). Survives the `aria-label`-between-class-and-href markup tweaks that broke the regex.
  - `lumen chat` TUI now handles three slash commands:

    - `/cost` — one-line budget snapshot injected as a synthetic assistant turn.
    - `/loop 5m <prompt>` — registers an `IntervalCron` for the TUI lifetime. Cron expressions are delegated to a P24 follow-up (IntervalCron's library does not ship a cron-parser yet).
    - `/init` — runs `analyzeCurrentProject()` and emits a Markdown factsheet (package manager + scripts + top-level directories).

  The full feature commits are `00e0b62` (P23.12.A budget snapshot), `db5c095` (P23.12.B HTML tokenizer), and `??` (P23.12.C slash commands). Nine new tests cover slash command parsing, the analyzer, and the tokenizer; `lumen doctor` returns 11/11 OK.

### Patch Changes

- Updated dependencies [bcf1501]
- Updated dependencies [f369f53]
- Updated dependencies [b4b62fb]
- Updated dependencies [e68c610]
- Updated dependencies [71316da]
- Updated dependencies [4b30e7e]
- Updated dependencies [76c5cfc]
- Updated dependencies [f11a82b]
- Updated dependencies [cd89661]
- Updated dependencies [37c19c9]
- Updated dependencies [6cab11f]
- Updated dependencies [17346c7]
  - @lumen/core@0.17.0
  - @lumen/memory@0.17.0
  - @lumen/mcp@0.16.0
  - @lumen/llm@0.16.0
  - @lumen/tools@0.16.0
  - @lumen/skills@0.16.0
  - @lumen/config@0.16.0
