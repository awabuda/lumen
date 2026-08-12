# @lumen/tools

## 0.18.3

### Patch Changes

- Updated dependencies [b68f836]
  - @lumen/core@0.22.0

## 0.18.2

### Patch Changes

- Updated dependencies [9590206]
  - @lumen/core@0.21.0

## 0.18.1

### Patch Changes

- Updated dependencies [63e3a12]
  - @lumen/core@0.20.0

## 0.18.0

### Minor Changes

- b70d785: P33.B Day1-Day5 — ProductAssembly + ToolRisk dispatch gate + FS workspace-root path-guard.

  The CLI composition root now resolves a ProductAssembly from `config.product.assembly` (or `defaultProfile` / `LUMEN_PRODUCT=off`) and auto-wires the `assistant` bundle (plan + tool-permission + skill-trigger + reflection). The bare assembly short-circuits the middleware array, giving operators an explicit escape hatch (`--profile bare`).

  @lumen/core:

  - `AgentConfig.workspaceRoot?` threads the pinned workspace into every `ToolContext` (P33.B Day2 pre-existing).
  - `AgentConfig.approver?` callback gates `approval-required` and `dangerous` tool dispatches (P33.B Day3).
  - `Agent.dispatchToolCall` reads `tool.risk`; `safe` calls dispatch unchanged, `approval-required` / `dangerous` route through the approver. No approver + dangerous = hard deny; approver throws = treated as deny.

  @lumen/tools:

  - `packages/tools/src/fs/workspace-guard.ts` ships `resolveSafePath(cwd, workspaceRoot)` with `path + sep` prefix check (P33.B Day2). The five FS tools (`read_file` / `write_file` / `patch` / `list_dir` / `search_files`) wire it into `execute()`.

  @lumen/config:

  - `LumenConfig.product` slice (strict, optional): `{ assembly?: string }`.
  - `BUILTIN_ASSEMBLIES` (`assistant` / `bare`), `resolveProductAssembly`, `profileNameToAssembly` exported.

  @lumen/cli:

  - `lumen doctor --product` flips G-P4 / G-P6 from FAIL to OK; G-P1 / G-P3 follow in phase B.
  - Three new `CliAgentOptions` opt-outs: `enableReflection`, `enablePlan`, `noPermission` (per P19+ rule 11 — opt-out, not enable-boolean).
  - `loadCliConfig` switches to `loadConfigWithProfile`.

  Test counts: core 656 → 667 (+11); cli 348 → 354 (+6); config 51 unchanged; monorepo 1844 tests / 0 fail / biome clean on touched files.

### Patch Changes

- Updated dependencies [b70d785]
  - @lumen/core@0.19.0

## 0.17.0

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

## 0.16.0

### Minor Changes

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

- 6cab11f: P23.12 — wires bug.md #64 / #69 / #70 / #71 end-to-end:

  - `Budget.tokensConsumed` / `.costUsdConsumed` / `.timeMsConsumed` (and a `used` getter alias) surface single-value counters the `/cost` slash command reads. Pure additions; every existing `Budget.snapshot()` call site is unaffected.
  - `Agent.budgetSnapshot()` returns the most recently completed `Budget` from the agent loop; wired by `executeLoop` to `this.lastBudget = budget` so the value survives across calls.
  - `DuckDuckGoSearchProvider.parse` replaces the pre-P23.12 mega-regex with a real streaming tokenizer (`packages/tools/src/web/html-tokenizer.ts`). Survives the `aria-label`-between-class-and-href markup tweaks that broke the regex.
  - `lumen chat` TUI now handles three slash commands:

    - `/cost` — one-line budget snapshot injected as a synthetic assistant turn.
    - `/loop 5m <prompt>` — registers an `IntervalCron` for the TUI lifetime. Cron expressions are delegated to a P24 follow-up (IntervalCron's library does not ship a cron-parser yet).
    - `/init` — runs `analyzeCurrentProject()` and emits a Markdown factsheet (package manager + scripts + top-level directories).

  The full feature commits are `00e0b62` (P23.12.A budget snapshot), `db5c095` (P23.12.B HTML tokenizer), and `??` (P23.12.C slash commands). Nine new tests cover slash command parsing, the analyzer, and the tokenizer; `lumen doctor` returns 11/11 OK.

- 17346c7: P24 + P25 — bug.md FEATURE_GAP sweep (16 commits).

  P24 closed three FEATURE_GAP items that fit inside the
  existing `tools` / `mcp` / `cli` packages:

  - **#9 web_browser tool** (P24.1) — single composite
    Playwright-backed tool with `goto` / `act` /
    `extract` / `screenshot` ops. Opt-in via
    `createBrowserTools()` and the `--web-browser` CLI
    flag; risk class `approval-required`.
  - **#47 fail-closed MCP** (P24.3) — `McpSecurityOptions`
    with `failClosed: true` (default) + per-server
    `allowServerIds` whitelist.
  - **#48 parallel MCP init** (P24.2) —
    `connectAllMcpServers` swapped from a serial loop to
    `Promise.all` with per-promise try/catch.

  P24.5 documents the explicit deferral of bug.md **#10
  Computer Use** — needs a native dep beyond `better-sqlite3`
  and would violate P22.7 §3.

  P25 closed the remaining in-scope FEATURE_GAP items:

  - **#37** SubAgentContext isolation (P25.1.A) — typed,
    append-only slice with `history` / `memo` /
    `createdAtMs` / `lastWriteMs` fields.
  - **#38** Auto-dispatch router (P25.1.B) — `nullRouter`
    - `heuristicSubAgentRouter` helpers.
  - **#39** Built-in sub-agent SKILL.md (P25.1.C) —
    `explore` / `plan` / `general-purpose` prompts ship
    at `packages/skills/skills/`.
  - **#43** Worktree isolation (P25.2) — `createWorktree`
    - `runInWorktree` helpers.
  - **#49** Background Task registry (P25.3) —
    spawn / await / cancel / list lifecycle.
  - **#50** Agent View (P25.4) — `snapshotAgentView` +
    `formatAgentView` helpers.
  - **#51** Proactive Agent wrapper (P25.9) — wake-up +
    decision + exit lifecycle + `exceedsHourlyBudget`
    rate guard.
  - **#52** Manifest-first config (P25.8) — `lumen` block
    of `package.json` as a project hint surface.
  - **#53** Permission Modes (P25.7) — `default` /
    `acceptEdits` / `auto` / `bypassPermissions`.
  - **#54** apply_patch (P25.5) — V4A patch parser +
    applier; updates that don't match the on-disk
    content are recorded as failures.
  - **#44** Message Channel interface (P25.10) — data
    layer only; the Slack / Telegram / WhatsApp reference
    adapters ship as separate files in a future P-ticket.

  The 4 remaining items are explicitly deferred:

  - **#10** Computer Use — P22.7 §3 native-dep guardrail.
  - **#45 #46** multimodal encoder / People-aware memory
    — P26+ until a multimodal embedding surface exists.

  TASKS.md: P23.11 + P23.12 + P24 + P25 sub-sections all
  marked `[x]`; 0 open items.

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
