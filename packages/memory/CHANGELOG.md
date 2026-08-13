# @lumen/memory

## 0.19.4

### Patch Changes

- Updated dependencies [e347bc5]
  - @lumen/core@0.23.0

## 0.19.3

### Patch Changes

- Updated dependencies [b68f836]
  - @lumen/core@0.22.0

## 0.19.2

### Patch Changes

- Updated dependencies [9590206]
  - @lumen/core@0.21.0

## 0.19.1

### Patch Changes

- Updated dependencies [63e3a12]
  - @lumen/core@0.20.0

## 0.19.0

### Minor Changes

- fe7924a: P34 — Phase B.1: MEMORY.md / USER.md human-readable memory bridge.

  @cmd-p34-bridge ships:

  - `packages/memory` markdown-bridge helpers (pure data; no fs):
    `serializeFactsToMarkdown`, `parseMarkdownFacts`,
    `buildMarkdownDocument`, `DEFAULT_TRUST_THRESHOLD = 0.6`.
  - `apps/cli/src/memory-markdown-bridge.ts`:
    `createMemoryMarkdownBridge({store, memoryMdPath,
userMdPath, trustThreshold})` with `syncAfterRun()`,
    `ingestIfNewer()`, `describe()`.
  - `apps/cli/src/commands/memory.ts`:
    `lumen memory sync` + `lumen memory show`.
  - `gateG_P1_openBoxUsability` flips WARN → OK.
  - `gateG_P3_observableLearning` flips WARN → OK.

  `lumen doctor --product` with empty ~/.lumen now reports
  "All product gates pass."

  Test counts: memory 225 → 238 (+13); cli 354 → 358 (+4);
  monorepo 1857 tests / 0 fail / biome clean on touched files.

## 0.18.1

### Patch Changes

- Updated dependencies [b70d785]
  - @lumen/core@0.19.0

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

### Patch Changes

- Updated dependencies [3211dcc]
  - @lumen/core@0.18.0

## 0.17.0

### Minor Changes

- b4b62fb: P23.8: Memory correctness sweep (fix #20, #21, #22, #32). SqliteStoreConfigSchema gains an optional `dimensions` field — the value was previously hardcoded to 1536 inside `buildVectorBackend()` and unreachable from outside the class. SqliteVecBackend.upsertBatch now wraps the batch in a single `db.transaction(...)` so a 100-point batch is one fsync + one rowid-lookup sweep instead of N of each (fix #21). The rowid hash is upgraded from FNV-1a 32-bit to FNV-1a 64-bit (bigint, narrowed to `Number` for the SQLite INTEGER bind), raising the collision-resistance ceiling from 2^32 to 2^64 (fix #22). `createProviderEmbedder` now forwards the declared `dimensions` to `source.embed()` instead of dropping it silently, so an operator asking for 1024-dim vectors actually gets 1024 (fix #32).
- 76c5cfc: P23.9: small correctness fixes across the audit (fix #11, #25, #26, #27, #28, #29, #30, #31, #41). Highlights: `mergeArgs` uses a `Symbol` for the raw-string slot so a tool arg literally named `__raw__` no longer collides (#11); FTS5 tokenisation preserves CJK + accented characters (#25); `PlanSchema` enforces mutex on `approvedAt` / `rejectedAt` (#29); `ClusterOptionsSchema` is now exported (#30); the `MinimalProvider` interface in `core/src/plan/index.ts` tracks `BaseProvider.chat`'s real signature so mocks pass at runtime (#31); `createProviderEmbedder` forwards `dimensions` (#32, also covered by P23.8); `persistExtractedFacts` parallelises the dedup + put path (#26); `HttpMcpTransport` lazy-validates `fetch` instead of throwing in the constructor (#27); the OpenAI-compatible stream emits a generated id when the upstream omits one (#28); `WebFetchTool.execute()` drops the redundant `text.slice(0, parsed.maxBytes)` — the truncated flag is computed against the original length (#41).
- 37c19c9: P23.11 — bug.md safety / quality / skill sweep (fix #24, #36, #55, #58, #59, #60, #62, #63, #67, #69, #70, #71, #72). Highlights:

  - `ProviderPool.stream` initialises `lastError` with a synthetic `ProviderError` so `PoolExhaustedError.attempts[*].error` is never undefined (#24).
  - `GitTool` builds the child env from a curated allowlist (PATH / HOME / LUMEN\_\* / git overrides) instead of `{ ...process.env, ...env }`; SSH_AUTH_SOCK and GPG_AGENT_INFO no longer leak into the spawned git child (#36).
  - `TerminalTool.execute` uses the imported `path` module (#58) and reads `ShellSandboxConfig.timeoutMs` from a cached config instead of a hardcoded 30s fallback (#59).
  - `GitTool` short-circuits when `ctx.signal.aborted === true` and returns a structured aborted output (#60).
  - `SqliteCheckpointStore` yields to the event loop with `setImmediate` after every operation so the `Promise<…>` return is a real microtask hop (#55).
  - `RingBufferWorkingMemory` uses a pre-allocated circular buffer (head + count) so append is O(1) after capacity instead of O(n) (#62).
  - `SessionGate` keeps a `Map<userId, sessionId>` reverse index so `open()` is O(1) instead of an O(n) scan (#63).
  - Skill template expansion helpers: `$ARGUMENTS`, named `$NAME` / `${NAME}` placeholders (#67).
  - Slash-command skill scaffolds: `/cost`, `/loop`, `/init` registered with parameter-aware triggers (#69, #70, #71). Full composition-root wiring is left to a P24 follow-up; the trigger surface and trigger parameters land now.
  - `callToolWithRetry(tool, input, ctx, cfg)` helper adds the same exponential-backoff-with-jitter surface to tool calls; default `maxAttempts: 1` preserves back-compat (#72).

### Patch Changes

- Updated dependencies [bcf1501]
- Updated dependencies [f369f53]
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
