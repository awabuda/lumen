# @lumen/cli

## 0.26.0

### Minor Changes

- 6b48704: P34.6 — `lumen team list --format json / --recursive`.

  The `lumen team list` sub-command gains two
  CI-friendly flags:

  - `--format <fmt>` — `'human'` (default) or
    `'json'`. The JSON variant emits a single array
    suitable for diffing against the listing in CI
    pipelines. Empty directory emits `[]`
    (deterministic).
  - `--recursive` — recurse into sub-directories
    when scanning for `team.json` / `*.team.json`.
    Pre-P34.6 only the top dir was scanned.

  Surface:

  - `apps/cli/src/commands/team.ts` —
    `discoverTeamFiles(dir, { recursive? })` is now
    visit-based; the recursive flag gates sub-dir
    descent. The `list` branch builds a structured
    `entries` array first, then renders to either
    human or JSON.
  - `TeamCommandOptions` gains `recursive?: boolean`
    - `format?: 'human' | 'json'`.
  - `apps/cli/src/index.ts` — `lumen team` sub-command
    gets `--recursive` and `--format <fmt>` flags.

  Test counts: cli 380 → 385 (+5); monorepo 1884
  tests / 0 fail / biome clean on touched files.

## 0.25.0

### Minor Changes

- e6b0922: P34.5.b — `--approve-all` / `--deny-all` flags (Phase B.5 second slice).

  The CLI now ships two flags that pre-resolve the
  agent's approver callback. Per P33.B Day3 the
  approver is a callback on `AgentConfig`; this
  commit threads two pre-resolved callbacks
  (`async () => 'allow'` / `async () => 'deny'`)
  through `buildAgent` so the operator can opt into
  a deterministic posture without writing code.

  Surface:

  - `apps/cli/src/composition.ts` —
    `CliAgentOptions` gains `approveAll?: boolean` +
    `denyAll?: boolean`. `buildAgent` builds the
    approver as `async () => 'allow'` / `'deny'`
    based on the flag; passes to
    `createAgent({ approver })`.
  - `apps/cli/src/commands/run.ts` +
    `commands/chat.tsx` — same flags on
    `RunCommandOptions` / `ChatCommandOptions`.
  - `apps/cli/src/index.ts` — registers
    `--approve-all` / `--deny-all` flags on
    `lumen run` + `lumen chat`.

  Mutual exclusion is enforced at composition time
  (approveAll wins when both are set). TUI real-time
  approval prompts remain a future P-ticket.

  Test counts: cli 380 unchanged; monorepo 1879
  tests / 0 fail / biome clean on touched files.

## 0.24.0

### Minor Changes

- d4fd36c: P34.5 — `lumen checkpoint restore` subcommand (Phase B.5 first slice).

  The CLI now ships a restore path that resolves a
  saved checkpoint by id, sessionId, or the most
  recent in-progress checkpoint across every
  session. The restore command does NOT run the
  agent — it emits the resolved checkpoint id (or
  the full JSON on `--json`) so the caller can
  attach it to the next `lumen run --resume-from
<path>:<id>` invocation.

  Surface:

  - `apps/cli/src/commands/checkpoint.ts` adds
    `checkpointRestoreCommand({id?, sessionId?,
latest?, json?, store?, file?})`. Same
    `resolveStore` helper as `list/show/delete`.
  - `apps/cli/src/index.ts` — new `restore` sub-
    command with `--session`, `--latest`, `--json`
    flags. `--id` is mutually exclusive with
    `--session` / `--latest` and the CLI surfaces a
    clear error when the operator mixes them.
  - `BaseCheckpointStore.latestInProgress` (already
    shipped in P32.3) is the underlying primitive.

  End-to-end verified:
  `lumen checkpoint restore --help` →
  `--session / --latest / --json` flags documented.

  Test counts: cli 374 → 380 (+6); monorepo 1879
  tests / 0 fail / biome clean on touched files.

## 0.23.0

### Minor Changes

- 8e7477f: P34.4 — `lumen gateway start|stop|status` subcommand (Phase B.4 closure).

  The CLI now ships a long-lived Node daemon that
  exposes the agent over HTTP + WebSocket. The gateway
  reuses `buildAgent` (the assistant assembly: plan /
  permission / skill / reflection / memory bridge) and
  wires it as `createNodeServer`'s `agentFactory`.

  Surface:

  - `apps/cli/src/commands/gateway.ts`:
    - `gatewayStartCommand({port?, host?, pathPrefix?})` —
      builds Agent + starts NodeHttpAdapter + installs
      SIGINT/SIGTERM graceful-shutdown.
    - `gatewayStopCommand()` — P34.4 stub; daemon mode
      is a future P-ticket.
    - `gatewayStatusCommand()` — prints the planned
      endpoint.
  - `apps/cli/src/index.ts` — registers `lumen gateway`
    with `--port / --host / --path-prefix` flags.
  - `apps/cli/package.json` — adds `@lumen/server`
    workspace dependency.

  End-to-end verified:
  `lumen gateway status --port 8888` →
  `planned endpoint: http://127.0.0.1:8888/v1`

  Test counts: cli 371 → 374 (+3); monorepo 1873 tests /
  0 fail / biome clean on touched files.

## 0.22.0

### Minor Changes

- aa57de2: P34.3 — `/trust` and `/plan` TUI slash commands (Phase B.3 closure).

  The TUI now exposes two new slash commands (no LLM call,
  pure data reads from the agent's SqliteStore + the
  in-memory PlanStore):

  - `/trust` — reads every record from `built.memory`,
    emits a per-kind count + mean / min / max trust
    distribution as a Markdown-flavoured table.
  - `/plan` — reads the live `PlanStore` that
    PlanMiddleware writes into, lists every saved
    plan with its step count.

  Surface:

  - `apps/cli/src/components/trust-plan-snapshot.ts` —
    new pure-data helpers (`aggregateTrustByKind`,
    `formatTrustSnapshot`, `formatPlanLine`,
    `formatPlanSnapshot`).
  - `apps/cli/src/components/slash-commands.ts` —
    `handleTrustSlash(built)` / `handlePlanSlash(built)`.
  - `apps/cli/src/components/Chat.tsx` — registers both
    slash commands in the `submit` branch.
  - `apps/cli/src/composition.ts` — `BuiltAgent.planStore?`
    field; every PlanMiddleware mount gets a fresh
    PlanStore.

  End-to-end verified: the snapshot output reads
  cleanly in Ink without breaking lines.

  Test counts: cli 362 → 371 (+9); monorepo 1870 tests /
  0 fail / biome clean on touched files.

## 0.21.0

### Minor Changes

- 3b99810: P34.2 — Skill auto-evolution (Phase B.2 closure).

  @cmd-p34-bridge:

  - `@lumen/skills` barrel now exports `BaseEvolver` /
    `HeuristicEvolver` / `LLMEvolver` / `EvolutionResult`
    / `EvolverChatMessage`.
  - `apps/cli/src/skill-evolution-bridge.ts` exports
    `createSkillEvolutionBridge({ skillsDir?, evolver? })`
    with a single `afterRunHook(result)` method.
  - `apps/cli/src/composition.ts` mounts the bridge
    as an `afterRun` middleware when the resolved
    assembly bundles `skillEvolution: 'trajectory'`
    AND the caller did not pass `noSkillEvolve`.
  - `BUILTIN_ASSEMBLIES.assistant.skillEvolution`
    flips from `'reserved'` (P33.B Day1 placeholder)
    to `'trajectory'` (active evolver).
  - New `CliAgentOptions.noSkillEvolve?: boolean`
    opt-out flag.

  End-to-end: a 3-tool-call run produces a new
  `SKILL.md` under the skills directory via the
  HeuristicEvolver template. LLM-backed evolution
  is exported but stays opt-in (future P-ticket).

  Test counts: cli 358 → 362 (+4); monorepo 1861 tests /
  0 fail / biome clean on touched files.

### Patch Changes

- Updated dependencies [3b99810]
  - @lumen/skills@0.17.0

## 0.20.0

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

### Patch Changes

- Updated dependencies [fe7924a]
  - @lumen/memory@0.19.0

## 0.19.0

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
  - @lumen/tools@0.18.0
  - @lumen/config@0.17.0
  - @lumen/llm@0.16.2
  - @lumen/mcp@0.16.2
  - @lumen/memory@0.18.1

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
