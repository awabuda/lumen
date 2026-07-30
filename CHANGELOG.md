# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/) on the public package surface
(`@lumen/core`, `@lumen/llm`, `@lumen/memory`, `@lumen/mcp`, `@lumen/tools`,
`@lumen/skills`, `@lumen/config`).

Test counts are point-in-time totals across the monorepo. The pre-1.0 series
(`0.x.y`) does not promise API stability; breaking changes are recorded as
**Changed** entries with a note about the migration path.

## [Unreleased] — P32 lumen chat persistence + session registry + cron durability

> **Multi-commit sweep on `lumen chat` durability.** 7 commits
> across P32.1 (default persistence + cwd-derived sessionId),
> P32.1.1 (mkdirSync invariant from a user-reported regression),
> P32.2 (mount-time history render), P32.3a/b (storage +
> `/sessions` slash command), P32.4 (`SqliteLoopsStore` + `/loop`
> cross-restart durability), and P32.5 (better-sqlite3 ABI drift
> check on `lumen doctor`). Net effect: every persistent
> surface (`chat.sqlite`, `loops.sqlite`, `~/.lumen/memory.db`)
> survives TUI restart without manual reload, and the surface
> regressions that blocked the implementation (the
> "Cannot open database because the directory does not exist"
> error, the `NODE_MODULE_VERSION` mismatch) now report at
> `lumen doctor` instead of inside an opaque driver throw.

### Added

  - **P32.1** `apps/cli/src/chat-paths.ts` — `defaultChatCheckpointPath()`
    (XDG-aware resolution: `$LUMEN_CHAT_CHECKPOINT_PATH`
    override → `$XDG_STATE_HOME/lumen/chat.sqlite` →
    `~/.local/state/lumen/chat.sqlite`) and `defaultChatSessionId(cwd)`
    (cwd-derived `chat-<cwdHash-8bytes-base64url>` for stable
    cross-launch session identity). Three new `lumen chat` flags:
    `--session-id <id>`, `--new-session`, `--no-persist`.
  - **P32.2** `apps/cli/src/components/restore-turns.ts` —
    `messagesToTurns()` pure helper that folds
    `AgentCheckpoint.messages` into `RestoredTurn[]` for the
    Chat TUI to render at mount time. Rules: drop system
    messages, fold tool-call loops into one assistant bubble,
    keep the in-progress trailing user message, render
    leading assistants with `user: ''`.
  - **P32.3** `BaseCheckpointStore.listSessions(options?)` plus
    `BaseCheckpointStore.deleteSession(id)` — SQLite-backed
    and InMemory-backed. Returns `CheckpointSessionSummary[]`
    (session id, last-created-at, checkpoint count, has-in-progress).
  - **P32.3** `lumen chat` ships `/sessions` slash command
    with five sub-commands: list (recent 10), list N,
    show <id>, switch <id>, delete <id>, help. The
    `<id>` argument is parsed as-is; the active session is
    tagged with a `←` marker. Switch is **restart-required**
    (writes `chat-next-session.json` + tells the user to
    exit and relaunch with `--session-id`); deleting the
    active session is refused.
  - **P32.4** `packages/memory/src/sqlite-loops-store.ts` —
    `SqliteLoopsStore` with `save` / `stop` / `recordTick` /
    `listAll` / `listActive` / `dispose`. Persists to its own
    `loops.sqlite` file under `$XDG_STATE_HOME/lumen/` (a
    separate table from chat history so the two
    lifecycles never collide). Schema: `loops(id, kind,
    interval_ms, cron_expr, prompt, registered_at,
    last_tick_at, stopped_at)` with `loops_active_idx` on
    `(stopped_at, registered_at)`.
  - **P32.4** `lumen chat` ships `/unloop <id>` slash command
    that stops the active timer and marks the persisted row
    inactive (`stopped_at IS NULL` becomes the filter on
    `listActive()`). On TUI mount, `reloadPersistedLoops()`
    re-arms every active row so closing and re-opening the
    TUI does not silently kill the schedule.
  - **P32.5** `apps/cli/src/native-abi.ts` —
    `probeBetterSqlite3Abi()` opens an in-memory SQLite handle
    to surface ABI drift as a first-class failure rather than
    the opaque `Cannot open database because the directory
    does not exist` error users hit on Node upgrade. `lumen
    doctor` gains check #10:
    `[OK] better-sqlite3 ABI matches current Node (modules=141)`
    or `[FAIL] better-sqlite3 ABI drift: binary compiled for
    NODE_MODULE_VERSION=X but Node is running Y. Run
    \`pnpm rebuild:native\`.`

### Changed

  - **P32.5** `apps/cli/package.json` declares
    `better-sqlite3` as a direct dependency. The runtime
    probe in `native-abi.ts` requires the package by name;
    without the explicit dependency pnpm's strict isolation
    hides the transitive binary from the doctor process
    even though the package is installed at the monorepo
    root.

### Docs / TASKS

  - `TASKS.md` — this section.
  - `CHANGELOG.md` — this `[Unreleased]` entry.

### Migration from 0.17.0

  - No breaking API change. Existing `lumen chat` users see
    the new cwd-derived `chat-<hash>` sessionId in their status
    bar on the next launch. To migrate to a fresh explicit
    id, run `lumen chat --session-id <name>`. To restore the
    pre-P32 behaviour (fresh uuid per launch), pass
    `--no-persist`.

## [0.17.0] — 2026-07-23 — P23 + P23.11 + P23.12 + P24 + P25 + P26 (bug.md audit + FEATURE_GAP sweep)

> **Multi-series sweep.** 17 commits across P23.0-P23.10
> (bug.md audit fixes), P23.11 (pool/tools/memory/skills
> polish), P23.12 (web/tokenizer/CLI shell), P24
> (browser + parallel MCP + fail-closed MCP), P25
> (sub-agent context / auto-dispatch / SKILL.md /
> worktree / background tasks / agent view / apply_patch
> / proactive / manifest / permission modes / channel
> interface), and P26.0 (design-only umbrella for the
> final 3 deferred items). Net effect on `bug.md`: 60/73
> ship-count after P22.7 → **69/73 after P25.6** → final
> banner at P26.0. The 4 remaining items are explicitly
> deferred under either the P22.7 §3 native-dep guardrail
> (#10 Computer Use) or the P26+ multimodal surface
> (#45 vision / #46 People-aware memory).

### Added

  - **P24.1** `@lumen/tools` `web_browser` tool — Playwright-backed single
    composite tool with `goto` / `act` / `extract` / `screenshot`
    operations. Opt-in via `createBrowserTools()` and the
    `--web-browser` CLI flag; risk class `approval-required`.
  - **P24.2** `@lumen/mcp` `connectAllMcpServers` runs in parallel
    (Promise.all with per-promise try/catch).
  - **P24.3** `@lumen/mcp` fail-closed MCP registry —
    `McpSecurityOptions` with `failClosed: true` (default) and per-server
    `allowServerIds` whitelist.
  - **P24.4** CLI `--web-browser` flag forwarded through
    `RunCommandOptions` to `buildAgent`.
  - **P25.1** SubAgentContext isolation (#37) — typed append-only slice
    with `history` / `memo` / `createdAtMs` / `lastWriteMs` fields.
  - **P25.1** auto-dispatch router helpers (#38) — `nullRouter` +
    `heuristicSubAgentRouter`.
  - **P25.1** built-in sub-agent SKILL.md (#39) — `explore` /
    `plan` / `general-purpose` prompts in
    `packages/skills/skills/`.
  - **P25.2** worktree isolation helpers (#43) —
    `createWorktree` + `runInWorktree`.
  - **P25.3** `BackgroundTaskRegistry` (#49) — spawn / await /
    cancel / list lifecycle.
  - **P25.4** Agent View (#50) — `snapshotAgentView` +
    `formatAgentView` helpers.
  - **P25.5** apply_patch (#54) — V4A patch parser +
    applier with strict Zod schemas.
  - **P25.7** Permission Modes (#53) — `default` /
    `acceptEdits` / `auto` / `bypassPermissions`.
  - **P25.8** Manifest-first config (#52) — `lumen` block
    of `package.json` as a project hint surface.
  - **P25.9** Proactive Agent wrapper (#51) — wake-up +
    decision + exit lifecycle + `exceedsHourlyBudget`
    rate guard.
  - **P25.10** Message Channel interface (#44 data layer)
    — `ChannelMessage` / `ChannelSend` Zod schemas +
    `MessageChannel` interface + `NullChannel` for
    tests.

### Documentation

  - **P24.0 / P25.0 / P26.0** design-locks at
    `docs/P24-DESIGN.md` / `docs/P25-DESIGN.md` /
    `docs/P26-DESIGN.md`. Each follows the P22.7 §0
    4-framework-fetch + 6-question-audit pattern.
  - **P24.5-DEFER-NOTE.md** documents the Computer Use
    (#10) deferral and the three re-open conditions.

## [0.12.0] — 2026-06-30 — P19+ middleware 范式 design lock (no code shipped)

> **Design-only pass.** This version reserves the 0.12.0 slot for the
> P19 implementation commits (P19.0 middleware layer, P19.1 plan/act,
> P19.2 reflection, P19.3 sub-agent, …). The design itself is locked
> in 2026-06-25 (three rounds of framework comparison against LangChain
> 1.0, LangGraph 1.0, OpenClaw, Claude Code, Hermes Agent, Cursor) and
> published this commit as docs + .cursor rules only — no `@lumen/*`
> package version bumps, no API surface change, no changeset required.
> The next 0.12.0 release entry will be regenerated by changesets when
> the first P19.x implementation commit lands.

### Added
- **`docs/P19-DESIGN.md` (new, 551 lines).** Full design doc for the
  P19+ middleware 范式 / 多 Agent 编排 / 反思 / 安全 block. The
  doc's eleven sections (0 上下文 + 6-question audit, 1 middleware
  spec, 2-7 per-ticket design, 8 关键决策, 9 总预算, 10 风险,
  11 引用) enumerate every P19.x ticket (P19.0–P19.7) with concrete
  file paths, sub-bullets, and the framework comparison that
  justified the choice. The 4-framework comparison rule (per CLAUDE.md
  rule 16) is enforced at §1, §3, §4, §6, §7 against LangChain 1.0,
  LangGraph 1.0, OpenClaw, Claude Code, and Hermes Agent.
- **`docs/PITFALLS.md` (new, 283 lines).** Lumen-side session
  learnings, started 2026-06-25 alongside the P19 decisions. Pulls the
  "Pre-flight 5-step probe" out of the design doc so it is reusable on
  every P-pass. Distinct from the Hermes agent's
  `lumen-agent-framework/references/pitfalls.md` — that one is the
  external agent's memory; this file is the lumen repository's own
  self-maintained wisdom and the only one `CLAUDE.md` references.
- **`.cursor/rules/lumen-p19.mdc` (new, ~7 KB).** Cursor auto-loaded
  rules distilled from `CLAUDE.md` P19+ rules 10-19 + Pre-flight 1-6.
  Active in any worktree that opens `lumen/` in Cursor. Companion file
  to `CLAUDE.md` (Hermes / Claude Code / other agents read CLAUDE.md;
  Cursor reads `.cursor/rules/*.mdc`). A follow-up commit should add
  P19-DESIGN.md / PITFALLS.md links to `docs/ARCHITECTURE.md` and
  `docs/index.md` so the design doc is reachable from the top-level
  architecture narrative (intentionally deferred to keep this design-
  lock pass surgical).

### Changed
- **`CLAUDE.md` — P19+ rules section (rules 10-19) + Pre-flight
  section.** Codifies the five 2026-06-25 范式: middleware > config;
  Zod state schema; `createAgent` factory; ≥ 2 implementations per
  abstract (else delete); helper functions over abstract classes.
  Adds the 4-framework comparison rule (rule 16) and the ToolRisk /
  Sandbox enforcement rules (17, 18). Rule 19 makes P19.1 / P19.2
  wire-up a hard prerequisite for closing those tickets, so that
  `BasePlanner` / `LLMPlanner` / `PlanStore` / `RuleBasedReflector` /
  `LLMReflector` (already exported since P9.5 / P12.5) stop being
  orphan code.
- **`TASKS.md` — P19 section appended (commit-by-commit ticket list
  + 关键决策 + 8-维度代码层对比表).** P19.0 (middleware 抽象) →
  P19.7 (bench) with per-ticket sub-bullets for files / tests / e2e
  count. The 8-dimension table at `TASKS.md` line 794+ cross-compares
  Lumen against LangChain 1.0, LangGraph 1.0, OpenClaw, Claude Code,
  and Hermes Agent on Architecture / Type / State / Tools / Memory /
  Concurrency / Testing / Documentation. The P20+ backlog (P20.1
  HITL … P20.10 dataset) is preserved from the design doc.
- **`apps/docs-site/.vitepress/config.mts` — `nav` and `sidebar`
  gain a "P19 Design" top-level entry and a "Pitfalls" reference
  entry.** No new markdown files under `apps/docs-site/` are needed
  because VitePress `srcDir` already points at the monorepo-root
  `docs/` directory (see the comment at the top of `config.mts` for
  the path math). Verified end-to-end: `pnpm --filter
  @lumen/docs-site build` (VitePress 1.6.4) succeeds in single-digit
  seconds with 0 errors and produces `docs-dist/P19-DESIGN.html` and
  `docs-dist/PITFALLS.html` at `/p19-design` and `/pitfalls`
  cleanUrls respectively. VitePress 1.x's default page-skip list
  excludes `CHANGELOG.md`, so the root changelog remains a top-level
  GitHub artifact and is not exposed as `/changelog` on the docs
  site.

### Not changed
- No `@lumen/*` package code touched. `pnpm -r typecheck` and
  `pnpm -r test` remain green at the 0.11.0 baseline. No package
  versions bumped. No changeset file added (the changesets workflow
  is reserved for shipped-feature PRs; docs-only / rules-only passes
  do not require one).
- No new top-level folders (lumen hard rule 9). `.cursor/rules/`
  was already a worktree directory at P19 design time (it predates
  this commit and was first added by an earlier Cursor rules
  experiment that did not land on `main`); P19-DESIGN.md and
  PITFALLS.md live under the existing `docs/` directory.

## [0.16.0] — 2026-07-15 — P22 permission modes for HITL tool dispatch

> **Permission-modes pass.** Closes the Q6 "operator-controlled
> tool gating" gap from the 2026-06-25 six-question audit. The
> agent loop now consults a static YAML policy file before
> the interrupt chain. Three outcomes: `allow` short-circuits,
> `deny` throws a typed `AbortError`, `ask` falls through to
> the existing interrupt middleware. The policy file supports
> a hand-rolled YAML subset (no `js-yaml` dependency) and
> cross-file composition via `imports:` with cycle detection
> and a managed-only lockout (`allowOverrides: false` default).
> A second layer — auto-mode — wires a heuristic risk-tiered
> classifier (`BaseRiskClassifier`) between the static layer
> and the interrupt chain. The classifier is **opt-in**; the
> policy file's `autoMode.enabled` field is the single source
> of truth. The framework's promise to operators is "every
> decision in the policy file is auditable from `git log`" —
> the auto-mode layer is heuristic, not LLM-based, to keep
> the audit promise intact.

### Added

- **Permission policy middleware (P22.0)** — `BaseToolPermissionPolicy`
  + `StaticToolPermissionPolicy` + `createToolPermissionMiddleware`
  in `packages/core/src/agent/middleware/tool-permission.ts`.
  Three outcomes (`allow` / `deny` / `ask`) with a per-rule
  `when:` block (`argMatches: Record<argKey, regex>`) for
  argument-level gating. 15 e2e tests.
- **Interrupt coexistence (P22.1)** — the permission middleware
  runs before the interrupt middleware; `ask` falls through,
  `allow` records and proceeds, `deny` throws `AbortError`
  with a name + tool context. The P20.4.2 catch path still
  auto-checkpoints on `deny`.
- **`--permissions <path>` flag (P22.2)** — `lumen run` /
  `lumen chat` accept a YAML policy file. The hand-rolled
  YAML parser covers scalars, inline lists (`[a, b]`),
  list-of-maps, nested objects, and the new multi-line list
  syntax (peek-down to choose array vs. object). 8 e2e tests.
- **`lumen init` (P22.3)** — writes a starter
  `~/.lumen/permissions.yaml` with `default: ask` + a
  least-privilege rule set. `--force` to overwrite,
  `--path <file>` to override. 7 e2e tests.
- **`lumen permissions show` (P22.3)** — prints the parsed
  policy in human-readable form. `--json` for machine-readable.
- **`lumen permissions preset` (P22.4)** — prints the
  recommended starter text to stdout (pipable to a file).
  1 e2e test.
- **`docs/PERMISSIONS.md` (P22.4)** — ~190-line operator guide
  covering policy file shape, 3-way decision semantics,
  `when:` argument matching, the `lumen permissions` command
  surface, and composition with the interrupt layer.
- **Auto-mode classifier (P22.5.0)** — `BaseRiskClassifier`
  interface + `AutoModeRulesSchema` (Zod, `.strict()`) +
  `createHeuristicRiskClassifier` + core-shipped risk table
  (`read_file` / `list_dir` → low, `write_file` → medium,
  `terminal` → high) + `createAutoModeMiddleware`. 14 e2e
  tests. The classifier is **never** LLM-based.
- **Auto-mode composition (P22.5.1)** — when the policy file
  declares `autoMode.enabled: true`, the composition root
  wires the heuristic engine between the static permission
  layer and the interrupt chain. The `lumen run --auto-mode`
  flag (P22.5.3) surfaces a one-line status from the file.
- **`autoMode:` policy block (P22.5.2)** — Zod optional,
  five fields: `enabled`, `neverAllowTools`, `hardDenyPatterns`,
  `allowPatterns`, `softDenyPatterns`. The `neverAllowTools`
  list is enforced even at `low` risk; `hardDenyPatterns` are
  regex matches against tool names that always deny. The
  audit-only `allowPatterns` / `softDenyPatterns` are written
  to the audit log.
- **`docs/AUTO-MODE.md` (P22.5.4)** — ~250-line operator guide
  covering the composition overview, the `autoMode` block
  shape, the core risk table, decision precedence
  (permission → permission-auto → interrupt), 3 worked
  examples, the CLI surface, and composition with the
  interrupt layer.
- **Cross-policy imports (P22.6.0)** — `imports: string[]` in
  the policy file. The loader walks the imports in order,
  appends the imported files' `rules` after the root's,
  and merges the `autoMode` block last-import-wins. The
  hand-rolled YAML parser learns multi-line list syntax.
  5 e2e tests.
- **Managed-only lockout (P22.6.1)** — `allowOverrides: boolean`
  field on the top-level policy (default `false`). When
  `false`, a rule in an imported file whose `name` collides
  with a root rule is dropped (the root wins). Mirrors
  Claude Code's `allowManagedPermissionRulesOnly`. 3 e2e
  tests.
- **Source attribution (P22.6.2)** — `lumen permissions show`
  annotates every rule with `(from <path>)`. The JSON form
  carries a `_sources` map (rule name → source file path).
  The loader tracks the source per rule; first-occurrence
  wins the source attribution (the root's rule on a name
  collision keeps the root's source). 3 e2e tests.
- **Audit log (P22.6.3)** — `lumen permissions audit [--format
  human|json|csv]`. Walks the policy (and imports) and emits
  one row per rule with name, tools, decision, source path,
  and **SHA-256 of the source file**. The hash pins the audit
  report to a specific file revision; `git checkout <sha> -- <policy>`
  + re-run the audit to verify a reviewer's local copy. 4
  e2e tests.
- **Cross-policy imports operator guide (P22.6.4)** —
  `docs/PERMISSIONS.md` §8 (5 subsections: 8.1 starter
  multi-file project, 8.2 cycle detection, 8.3 managed-only
  lockout, 8.4 source attribution, 8.5 the audit log).
- **P19.5.5** — asymmetric trust delta in `@lumen/memory`.
  The fact_store now records trust-deltas that account for
  older observations decaying slower than newer ones.
  Triggered by a production run-end reflection signal in
  2026-07-12; the previous "wait for production signal"
  blocker is closed. 3 sibling commits (e028f33, 76387f5,
  e054a7b).

### Changed

- The hand-rolled YAML parser in `apps/cli/src/permissions-loader.ts`
  was extended in two passes: first to support `imports:`
  multi-line lists, then to learn the `autoMode:` block
  shape. The parser stays a single file (~290 lines) with
  no `js-yaml` dependency.
- `apps/cli/src/composition.ts` learned the `permissionsPath`
  option (P22.2) and the `autoMode` block detection (P22.5.1).
  Composition order: `tool-permission` → `tool-permission-auto`
  → `interrupt` → `plan` → `skill-trigger`.

### Migration from 0.14.0

- Operators who do not pass `--permissions <path>` see no
  change. The default `default: ask` for every tool call is
  the historical behavior; the interrupt middleware has
  always been the gate.
- The `tool-permission` middleware name (`'tool-permission'`)
  sorts before `'interrupt'` alphabetically, so the order
  in the chain is automatic. No composition config change is
  required.
- The P22.6.0 YAML parser learned a new construct (multi-line
  list); existing single-file policies continue to parse
  byte-identical.

### Test counts (point-in-time)

- `@lumen/core`: 423 e2e tests (P22 + P22.5 + P22.6.0 = +33).
- `@lumen/cli`: 204 e2e tests (P22.2 + P22.3 + P22.4 + P22.5 +
  P22.6.0–P22.6.3 = +39).
- `@lumen/memory`: 175 e2e tests (P19.5.5 = +10).
- `pnpm -r typecheck`: 11/11 packages PASS.

## [0.14.0] — 2026-07-13 — P21 durable execution pass

> **Durable-execution pass.** Closes the Q5 "failure recovery" gap from
> the 2026-06-25 six-question audit. The agent loop now saves an
> in-progress checkpoint on every completed step, `lumen run` /
> `lumen chat` auto-resume a fresh checkpoint inside a 10-minute TTL,
> and `runWithHeartbeat` exposes a second wall-clock checkpoint poll
> so long-running agents can be observed independently of how many
> model turns fit in a window. P21.0 also lands a bench suite under
> `apps/cli/test/perf/09-durable-execution.test.ts` (opt-in via
> `LUMEN_BENCH=1`).

### Added
- **`packages/core/src/agent/checkpoint.ts` — `AgentCheckpoint.outcome`**
  (`'in_progress' | 'success' | 'error'`) plus the helper
  `saveCheckpointBestEffort` that `Agent.run` and `Agent.streamRun`
  share. Step-level saves are governed by
  `AgentRunOptions.checkpointInterval` (default 1; must be a positive
  integer). The run-end save is always attempted and tagged with
  `outcome: 'success'`. A throw path saves one last snapshot with
  `outcome: 'error'` and a distinct id so auto-resume can keep the
  last in-progress snapshot available.
- **`packages/core/src/agent/checkpoint.ts` — `BaseCheckpointStore.latestInProgress({ sessionId?, minCreatedAt? })`**
  contract. `InMemoryCheckpointStore` and `SqliteCheckpointStore`
  both implement it. The `SqliteCheckpointStore` schema adds an
  `outcome TEXT` column with a backward-compatible
  `ALTER TABLE ... ADD COLUMN` migration for databases created
  before P21.
- **`apps/cli/src/checkpoint-resume.ts` — `findResumeCheckpoint`**
  helper with a 10-minute default TTL (`DEFAULT_RESUME_TTL_MS`).
  Returns `undefined` for stale, terminal, or absent checkpoints
  and validates the TTL is a positive integer.
- **`runWithHeartbeat` (P20.2) gains a checkpoint poll** that, given
  a `BaseCheckpointStore` and a `checkpointIntervalMs`, fires
  `onCheckpoint(snapshot)` with the freshest in-progress snapshot at
  a deterministic wall-clock interval. Independent of the agent
  loop's step-level save.
- **`lumen run` and `lumen chat` flags** for durable execution:
  `--checkpoint <path>`, `--session-id <id>`, `--no-resume`,
  `--resume-ttl <ms>` (default 600 000), and
  `--checkpoint-interval <steps>` (default 1). `lumen chat` mounts
  the SQLite-backed checkpoint store for the entire TUI session and
  threads the recovered snapshot into the first `streamRun` call.
- **P21.3 bench suite** at `apps/cli/test/perf/09-durable-execution.test.ts`
  (opt-in `LUMEN_BENCH=1`): step-checkpoint cost over 100 steps,
  resume lookup latency, 50 concurrent saves, checkpoint JSON size,
  and the stale-resume rejection path.

### Changed
- **`Agent.streamRun` now respects `resumeFrom` the same way `Agent.run` does.**
  The first TUI turn after a crash picks up where the previous
  session left off, with the full message prefix restored.
- **Composition wraps the skill-trigger adapter** so the
  Zod-validated middleware accepts the adapter's
  `ReadonlyArray<ActiveSkill>` return type without losing the
  readonly contract. Unblocks `pnpm -r typecheck` after the core
  rebuild.

## [0.13.0] — 2026-07-07 — P19 + P20 implementation pass

> **Bead-surface pass.** This release implements the P19+ middleware
> 范式 (design-only in 0.12.0) and ships the P20 backlog (checkpoints,
> heartbeat, observability, skill trigger, context compression,
> dataset + scoring). The version is bumped to 0.13.0 because every
> public surface in `@lumen/core` has a new `export { ... }` — pre-1.0
> series does not promise API stability (see the "Test counts" line at
> the top of this file), so minor-version is the right call.

**Totals:** 41 feature commits (from `5106481` P19.0.1 AgentMiddleware
through `7c2de26` P20.10 dataset + scoring, plus the `3110f73` TASKS.md
sync), 67 new files / ~24 modified, ~+11,000 lines, +280 tests
(680 → 960). 0 type errors across the 11-package workspace.

### Added — P19 middleware 范式

- **`AgentMiddleware` abstraction (P19.0.1, `5106481`).** Plain-object
  middleware with `name`, `stateSchema`, `initialState`, and 5 hooks
  (`beforeModel` / `afterModel` / `wrapModelCall` / `wrapToolCall` /
  `afterRun`). `parseMiddleware` validates name uniqueness at
  construction time. `MiddlewareError` carries the offending
  middleware name. P19+ rule 11 in enforced form: any extension to
  the agent loop is a middleware, never an `AgentConfig` boolean.
- **`Agent.run` middleware wire-up (P19.0.2, `d6918a2`).** Step
  boundary: `beforeModel` → `wrapModelCall` → `afterModel` →
  `wrapToolCall` (per call) → `afterRun`. Bare `new Agent({...})` is
  unchanged behaviour (no middleware = old loop exactly).
- **`createAgent` factory (P19.0.3, `815afca`).** The composition
  root's documented entry point. P19.0.3 follow-up `e363f9d` wired
  the CLI's `composition.ts` to it: `--plan` flag opts into
  `createPlanMiddleware({ mode: 'auto' })`.
- **Plan / Act / Auto middleware (P19.1, `9d8735e`).**
  `createPlanMiddleware({ mode, planner?, planStore? })`. The
  `auto` mode uses `MiddlewareControl.continueAfterModel` to chain
  planning → acting within a single run. P19.1.4 refactor
  (`8c37857`) replaced the abstract `BasePlanner` with an
  interface + `LLMPlanner` / `StaticPlanner` helper functions
  (P19+ rule 15).
- **Reflection middleware (P19.2, `433daae`).** Three modes:
  inline (`[confidence: 0.XX]` suffix per assistant message),
  step-level (rule-based heuristic every N steps), run-end
  (persists a `reflection-*` fact to `BaseMemoryStore`). 5 e2e
  cover the three modes. P19.2.5 refactor (`9042601`) replaced
  the abstract `BaseReflector` with `LLMReflector` /
  `RuleBasedReflector` helpers.
- **Sub-agent orchestration (P19.3 + P19.4, `bb07060`, `2e29907`,
  `e3f6c1f`).** Sequential + Parallel (`Promise.all` + 60s
  timeout), Handoff (OpenAI Swarm style — sub-agent emits a
  `handoff` tool call, payload surfaces in the parent context),
  Supervisor (per-step judge with `continue | redo | abort`).
  9 e2e across the four modes. P19.3.1-2 (`fa24bf4`) deleted the
  abstract `BaseSubAgent` (one-impl wrapper class) per P19+ rule
  14. `SubAgentMiddleware` (P19.3.3, `f22ffcd`) exposes a
  `task` tool; the P19.4.3 follow-up `2e29907` added
  `enableHandoff: boolean` so callers can route through either
  the plain runner or `createHandoffSubAgent` transparently.
- **Meta-reflector (P19.5, `c58585c`).** `BaseMetaReflector` +
  `createClusteringMetaReflector` factory. Jaccard-token clusterer
  on `(kind, tag-set)` partitions, with a `±0.1` log-decay
  `applyTrustDelta` helper. The P19.5 design basis
  (`docs/p19.5-meta-reflector-design-basis.md`, 273 lines) records
  the 4-framework comparison that informed the choice: the only
  upstream model that has a true trust-delta mechanism is Hermes
  Agent's `fact_feedback` (asymmetric +0.05 / -0.10). OpenClaw's
  "daily→long-term distillation" cited in the P19-DESIGN doc is
  **unverified** — the 1d00a81 commit marks the prior claims as
  "未验证" and the public P19.5 implementation aligns with the
  verifiable Hermes pattern.
- **CLI surfaces (P19.6, `8656952`, `ab69d7e`).** `lumen plan
  list / approve / reject` and `lumen reflect run / meta`. CLI
  storage is JSON-on-disk for plans (`~/.lumen/plans.json`) and
  SQLite for memory (existing). 12 CLI integration tests.
- **Bench harness (P19.7, `5641199`, `4e28a46`, `ad81dff`,
  `9f9550e`).** Four perf scenarios under `LUMEN_BENCH=1`:
  sequential sub-agent, parallel sub-agent, 4-mode reflection
  overhead, 10-run meta reflection. P19.7.5 (`9edf2a4`) adds
  rule-based quality score helpers (`planCoverageScore`,
  `reflectionConfidenceScore`, `subagentCoordinationScore`,
  `computeQualityScores`) for the LangSmith-style second axis.

### Added — P20 backend hardening

- **Checkpoint / Resume (P20.4, `291a943`, `33149a6`, `5154b99`,
  `564ea1e`).** `AgentCheckpoint` interface + Zod schema +
  `BaseCheckpointStore` interface + `InMemoryCheckpointStore`
  (in-process) + `SqliteCheckpointStore` (cross-process,
  better-sqlite3, WAL). `Agent.run` accepts `resumeFrom?` and
  `checkpointStore?`; aborts auto-save the current state. The
  `lumen checkpoint list / show / delete` CLI surface
  (P20.4.3) lives entirely on the in-memory store today; the
  CLI's SQLite integration is a future P20.4.x.
- **Provider pool fallback + auto-checkpoint (P20.5, `b6cb0d1`).**
  The fallback chain contract: when the pool falls back
  successfully, Agent.run never throws and no checkpoint is
  saved; when every provider exhausts, `PoolExhaustedError` is
  caught by the P20.4.2 path and the run snapshot is preserved.
- **HITL interrupt middleware (P20.1.1, `6b55ac9`).**
  `createInterruptMiddleware({ toolNames?, maxIterations?,
  onError? })`. Throws `AbortError` when a configured rule
  fires; the existing P20.4.2 catch path takes over
  (auto-save + re-throw). 6 e2e cover rule validation,
  tool-name + maxIterations trigger paths, and the
  not-in-list pass-through.
- **Heartbeat / long-running supervisor (P20.2, `4feda2c`).**
  `startHeartbeat({ intervalMs, timeoutMs?, onPing?, onTimeout? })`
  + `runWithHeartbeat(runner, options)`. The supervisor is an
  outer wrapper, **not** a middleware: the agent loop has no
  "last activity" hook, and P19+ rule 11 says middleware > config
  flag for loop extensions. Default 30 000 ms interval.
- **Context compression middleware (P20.3, `4cff9f1`).**
  `createContextCompressionMiddleware({ maxMessages?, keepLastN?,
  summaryFn? })`. When the history grows past `maxMessages`, the
  oldest `length - keepLastN` messages are replaced with a
  single system-role summary; the tail is preserved verbatim.
  The default `summaryFn` is a deterministic 200-char truncation
  (no LLM, no API call). Callers compose their own `summaryFn`
  for LLM-backed summarisation.
- **Skill trigger middleware (P20.6, `0969118`).**
  `createSkillTriggerMiddleware({ trigger, maxActive?,
  formatActive? })`. The trigger function is supplied by the
  caller — the core package does not import `@lumen/skills`,
  preserving tier isolation. The `apps/cli` layer composes the
  trigger with `KeywordTrigger` or `EmbeddingTrigger` from
  `@lumen/skills` in a future P20.6.x.
- **Observability — trace context (P20.8, `8015520`).**
  `createTrace({ traceId?, spanId?, parentSpanId?, name? })` +
  `runWithTrace(trace, runner)` + `formatTrace(trace)`. 16-hex-char
  identifiers (8 random bytes each); forward-compatible with W3C
  / OpenTelemetry bridges via a future `toOtelContext` adapter.
- **Dataset + scoring (P20.10, `7c2de26`).**
  `BenchmarkCase<TInput, TExpected>` + `BenchmarkScore` +
  `BenchmarkScoreSchema` (Zod, strict) + `runDatasetBench({ name,
  cases, runner })` + `reportTableRow(report)`. Per-case errors
  are caught and recorded as `passed: false` rows; the helper
  never throws. 11 e2e. A future P20.10.2 can rewrite the
  existing per-scenario bench files in terms of
  `runDatasetBench` without changing the bench output format.

### Docs

- **`docs/P19-DESIGN.md`** (already in 0.12.0) — unchanged; the
  P19+ implementation in 0.13.0 is a faithful transcription of
  the design.
- **`docs/p19.5-meta-reflector-design-basis.md`** (273 lines,
  `64c0a29`). The 4-framework comparison that informed P19.5;
  records the OpenClaw unverified-claim correction.
- **`docs/P20.7-agent-team.md`** (108 lines, `be21f65`). Agent
  team design baseline: documents how P19.3 + P19.4 compose via
  shared PlanStore to support multi-agent workflows. The future
  P20.7.x sub-tickets are scoped to `apps/cli`; core is not
  modified.
- **`docs/GETTING-STARTED.md`** (251 lines, `4669a34`). The
  user-facing entry point. Eight sections: install, first run,
  config, 5 providers, 5 use cases in 60 s, next steps, CLI map,
  pinned design commitments (the four lumen rules: middleware
  > config flag, helper > abstract class, tier isolation,
  no SaaS).

### Compatibility

- The 0.13.0 line is source-compatible with the bare-`Agent`
  0.10-0.12 constructor: every new public export is an
  `export { ... }` addition, no signature change. Operators
  who instantiate `new Agent({...})` see no behavioural change
  unless they explicitly add a `middleware: [...]` array.
- Tier isolation is preserved: `@lumen/core` does not import
  `@lumen/memory`, `@lumen/skills`, `@lumen/tools`,
  `@lumen/mcp`, or `@lumen/llm`. SQLite-backed checkpoint
  store lives in `@lumen/memory` (downstream of core). Skill
  trigger middleware accepts a caller-supplied trigger
  function rather than importing `@lumen/skills`.
- No external SaaS: no LangSmith, no OpenClaw hosted, no
  OpenTelemetry collector. The trace context (P20.8) is the
  local-only observability hook; a future `toOtelContext`
  adapter is the only sanctioned bridge to external systems.

## [0.10.0] — 2026-06-16 — P9 Hardening (errors, safety, failure fallback)

**Totals:** 4 feature commits (2108a00, f65973a, 56f6333, 53e65c3), 4 new
files / ~28 modified, ~+1,400 lines, +33 tests (887 → 920), 82 test
files, 11 packages, 43 commits on `main`. Typecheck clean. Biome clean
on touched files.

### Added
- **`withRetry` helper (P9.1, commit `f65973a` part).** New
  `packages/core/src/retry.ts` exports `withRetry<T>(fn, config?)` with
  `maxAttempts` (default 3), `initialDelayMs` (default 100),
  `maxDelayMs` (default 5000), `backoffFactor` (default 2), `jitter`,
  `shouldRetry`, `signal`, and injectable `sleep` for tests. Throws
  `RetryExhaustedError extends AgentError` (with `cause: lastError`,
  `attempts: number`) when the budget is spent, or `RetryAbortedError`
  when the signal aborts. `defaultShouldRetry` honors a `retryable`
  flag on the error first, then falls back to the `ProviderError`
  status heuristic (5xx / 408 / 429).
- **Circuit breaker (P9.4, commit `53e65c3` part).** New
  `packages/core/src/agent/circuit-breaker.ts` ships a
  `CircuitBreaker` class with a closed / open / half-open state
  machine, configurable `failureThreshold` (default 5) and
  `cooldownMs` (default 30_000). Throws `CircuitOpenError extends
  AgentError` carrying the offending `providerId` and `retryAfterMs`.
  8 unit tests cover the state machine and the boundary conditions.
- **`ProviderPool` circuit integration (P9.4).**
  `candidatesFor(...)` filters out providers whose breaker is open;
  `runWithFailover` calls `recordSuccess` on the chosen provider and
  `recordFailure` on the failed candidates. An open circuit produces a
  `CircuitOpenError` that is itself recorded as a non-fatal skip — the
  loop continues to the next candidate without counting it against
  the breaker (no point in punishing the breaker for being open).
  Back-compat: no `circuit` option = behavior unchanged.
- **DefaultSandbox path-traversal defense (P9.3, commit `53e65c3`
  part).** `DefaultSandbox.run` now rejects a `cwd` whose resolved
  path falls outside `workspaceRoot`. Throws `ConfigError` with
  `field: 'cwd'`. 4 new tests cover relative-cwd, absolute-cwd,
  parent-`..` traversal, and the legitimate same-root case.
- **web_fetch streaming size cap (P9.3).** The fetch path now streams
  chunks and aborts via `reader.cancel()` once the per-byte
  accumulator exceeds `maxBytes`. A hostile or lying `Content-Length`
  still cannot OOM the agent. 3 new tests cover the abort paths.

### Changed
- **78 `throw new Error(...)` sites now typed (P9.2, commit
  `56f6333`).** Every site audited and reclassified:
  `ConfigError` (resource / registration / strategy errors),
  `ValidationError` (input / parameter errors), `ProviderError` (LLM
  runtime errors, with `providerId` + `retryable`),
  `AbortError` (user cancellation), `ToolError` (tool-internal
  invariant, requires `toolName` in the options), `SkillConfigError` /
  `SkillParseError` (in a new `packages/skills/src/errors.ts` to keep
  the package decoupled from `@lumen/core` dist), and a new
  `MutexDisposedError` (lives next to the mutex). Coverage by
  package: core 25, skills 6, llm 15, memory 6, tools 11, mcp 1.
  Catching logic can now `instanceof`-discriminate without parsing
  the message.
- **4 LLM providers integrate `withRetry` (P9.1).** OpenAI-compatible,
  Anthropic, Gemini, Mistral — their `performFetch` rewrapped so a
  non-2xx response throws `ProviderError` (with status + retryable)
  inside the `doFetch` closure, and the closure is then passed to
  `withRetry` when `this.retry` is configured. Back-compat: no
  `retry` option = behavior unchanged (P8 callers unaffected).
- **`terminal` tool returns `policy-violation` instead of throwing
  (P9.3).** argv[0] containing a shell metacharacter is no longer an
  unhandled `Error` — it returns a structured refusal result. Honors
  CLAUDE.md rule #7 ("No try/catch that swallows" — better: don't
  throw, return a typed refusal).
- **Biome `noNonNullAssertion` disabled (P9.0, commit `2108a00`).**
  TS narrowing makes `!` safe in our codebase; Biome was flagging
  legitimate uses in `pool.ts` / `retriever.ts`. Set to `"off"` in
  `biome.json` `style.noNonNullAssertion`.

### Migration notes
- Catchers that used to match `err.message.includes('disposed')` on
  the mutex now use `instanceof MutexDisposedError`. The string match
  still works (the message is preserved), but the typed check is
  preferred.
- `ToolError` callers **must** pass the second `options` argument
  (with `toolName`) — the typecheck enforces this. Sites that omit
  the second arg will see `error TS2554: Expected 2 arguments`.
- `ProviderError` import path: it lives in
  `packages/core/src/errors/index.ts`, **not** in
  `packages/core/src/message/index.ts`. The package barrel
  `@lumen/core` re-exports it.
- `MutexDisposedError` lives in
  `packages/core/src/concurrency/mutex.ts` and is re-exported from
  `packages/core/src/concurrency/index.ts` and the core barrel.

## [0.10.0] — 2026-06-17 — P10 Input validation for @lumen/memory

**Totals:** 1 commit (`4031a5d`), 2 new files / 8 modified, +507/-29 lines,
+27 tests (920 → 947), 83 test files. Typecheck clean. Biome clean.

### Added
- **`packages/memory/src/schemas.ts`** (new, 182 lines) — six Zod
  schemas covering every user-supplied input type for
  `@lumen/memory`:
  - `SqliteStoreConfigSchema` (path non-empty, optional `readonly`
    and `verbose` function)
  - `RagPipelineOptionsSchema` (three collaborators typed as
    `z.unknown()` — see Migration note below)
  - `ProviderEmbedderOptionsSchema` (model non-empty,
    `dimensions` int+optional, `signal` AbortSignal)
  - `MemoryQuerySchema` (`minTrust` 0–1, `limit` int+)
  - `IngestInputSchema` (+ internal `RagChunkSchema` with
    `endOffset >= startOffset` refine)
  - `RetrieveInputSchema` (query non-empty, `limit` int+)
  - `parseOrThrow(schema, input, field)` helper that re-shapes a
    `ZodError` into the typed `ValidationError` from `@lumen/core`
    (chained as `cause`) and embeds the field path in the message.

- **Validation wired at 6 entry points** in `@lumen/memory`:
  - `SqliteStore` constructor
  - `InMemoryStore.search` and `SqliteStore.search` (both)
  - `createProviderEmbedder` factory
  - `RagPipeline` constructor, `RagPipeline.ingest`, and
    `RagPipeline.retrieve`

- **27 new tests** in `test/schemas.test.ts` — `parseOrThrow` helper
  + valid/invalid paths for each schema (empty strings, out-of-range
  numerics, unknown extra keys, `z.unknown()` optionality).

### Changed
- `packages/memory/package.json` — added `zod: ^3.23.0` to
  `dependencies` (matching the 9 sibling packages).
- Two existing tests in `test/embedder.test.ts` and
  `test/rag.test.ts` were updated to match the new
  `ValidationError` message shape (Zod's structured path-based
  message replaces the previous hand-rolled text).

### Migration notes
- **`RagPipelineOptionsSchema` uses `z.unknown()` for `embedder` /
  `backend` / `chunker`.** The naive `z.object({}).passthrough()`
  would clone the input, losing the class prototype chain on real
  instances (`BruteForceVectorBackend`, `TextEmbedder`,
  `ChunkerFunction`) and producing `backend.upsert is not a
  function` at runtime. `z.unknown()` preserves the reference.
  TypeScript continues to enforce the actual contract at the call
  site; the schema's job is to reject unknown extra keys.
- **No public type changes.** Valid inputs behave identically. The
  only observable difference is the error message text on invalid
  input — e.g. `"options.model is required"` →
  `"schema for options: model: model must not be empty"`. Callers
  that match on the old text should switch to
  `instanceof ValidationError` + check the `field` property.
- **No version bump** in this commit: the 0.10.0 series continues.
  Next non-breaking feature batch will bump to 0.11.0.

## [0.10.0] — 2026-06-17 — P11 Tooling/test hygiene (biome cleanup, env-var footgun)

**Totals:** 1 commit (`2444b72`), 132 files modified, +692/-629 lines, no test
count change (947 → 947), 11 packages, 47 commits on `main`. Typecheck
clean. `pnpm exec biome check` clean across 242 files (was 235 errors at
the start of the pass).

### Fixed
- **Biome cleanup pass.** 235 errors → 0. Bulk auto-fix
  (`biome check --write --unsafe`) handled 228 of them. The remaining 7
  were semantic and required judgement: `noAssignInExpressions` in
  `apps/cli/test/default-command.test.ts:51-52` (refactored to
  explicit `if`/block form), `noImplicitAnyLet` + `useYield` in
  `packages/core/test/agent-stream.test.ts:108,189` (added explicit
  `Extract<StreamEvent, { type: 'run:end' }>` and `biome-ignore` for the
  throwing-stream generator), and 3 `noExplicitAny` abstract-class test
  guards. After fixing those, biome surfaced 4 more identical guards in
  the bridge test files (`editor-bridge`, `server`, `desktop-bridge`).
- **`process.env.X = undefined` footgun re-triggered.** A late-2025
  `biome --write` run had auto-converted `delete process.env.X` to
  `process.env.X = undefined` in 9 sites across 5 test files (the audit
  had flagged one but missed eight). The P9 audit's `pitfalls.md` entry
  for this footgun fired again — exactly the documented symptoms
  (`received: "undefined"` for the `logging.level` enum, expected env
  vars becoming the string `"undefined"`). All 9 sites now use `delete`
  with a per-site `biome-ignore lint/performance/noDelete` comment
  explaining why.
- **`ChatMessage` exported from `@lumen/skills`.** The `as any` casts in
  `packages/skills/test/evolver.test.ts` and
  `packages/skills/src/trajectory-hook.ts:73` were replaced with
  `as ReadonlyArray<ChatMessage>` / `as ChatMessage[]`. Marked the
  local `ChatMessage` interface as `export` so it can be imported from
  tests and adjacent prod code.
- **MCP `discover.ts:36` `noImplicitAnyLet`** — annotated the
  `let transport` declaration with the abstract `McpTransport` type and
  added the type-only import to the existing `import { ... }` group.
- **Tools `text/chunker.ts:237,265`** — added `biome-ignore` for the
  `RegExp.exec()` `while ((m = re.exec(text)) !== null)` iteration
  idiom (splitting the assignment+test would only obscure intent).

### Notes
- **No version bump**: tooling/test hygiene, no public API change.
  CHANGELOG 0.10.0 still covers everything in flight.
- **Pitfalls.** The `process.env.X = undefined` footgun is already
  documented in `~/.hermes/skills/lumen-agent-framework/references/pitfalls.md`.
  This pass did not add a new entry — the existing one covers both the
  failure mode and the correct fix.
- **Push status:** same — remote unreachable, no retry. Local commits
  are safe.

## [0.10.0] — 2026-06-17 — P13 SqliteStore lifecycle state machine

**Totals:** 1 commit (`2803c5e`), 2 files (1 new), +292/-46 lines,
+14 tests (947 → 961), 12 packages, 51 commits on `main`.
Typecheck clean. Biome clean.

### Added
- **Three-state lifecycle machine** in `SqliteStore`:
  `'uninit' | 'ready' | 'closed'`. Replaces the single
  `initialized: boolean` flag. Every public method dispatches
  on the state and throws a typed `ConfigError` on a
  lifecycle violation; `dispose()` is idempotent.

### Fixed
- **3 silent footguns in the previous `init()` flow:**
  1. `init()` no-op'd on a second call (`if (initialized) return`)
  2. `init()` after `dispose()` would crash on a closed DB
  3. `init()` that threw partway left the instance in a
     half-baked state where a retry would re-run DDL against a
     corrupted file
- **5 public methods that escaped sync throws.** `get`, `search`,
  `listSessions`, `getSession`, and `getSessionMessages` used
  `Promise.resolve(syncWork())` which escaped a sync throw from
  the `s` accessor. A lifecycle error would surface as a
  synchronous throw, not a rejected promise — `await store.get('x')
  .catch(...)` would miss it. All five now use the
  `try { ... } catch { reject }` wrapper pattern that `put`,
  `createSession`, `appendMessage`, and `prune` already used.

### Tests
- new file: `packages/memory/test/init-order.test.ts` — 14 cases
  covering every state-machine transition: rejects every public
  method before init(), rejects `init()` called twice
  ("already ready"), rejects `init()` called after dispose
  ("create a new"), rejects methods after dispose, `dispose()`
  is idempotent, `dispose()` before `init()` is a no-op, init
  failure on a corrupted file leaves the instance in `'closed'`,
  validates config at the constructor boundary, and pins a
  happy-path read-after-write round-trip.

### Notes
- **No version bump**: internal hardening, no public API change.
  The new error messages are added but the *types* of the existing
  `ConfigError` rejects are unchanged.
- **No `reset()` or `reinit()` method** by design. Single-use
  instances keep the lifecycle simple; long-lived daemons that
  need to re-open construct a new `SqliteStore`.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P16 git.ts schema as discriminatedUnion

**Totals:** 1 commit (`2cd0d6f`), 2 files modified, +73/-45 lines,
test count +1 (961 → 962), 12 packages, 57 commits on `main`.
Typecheck clean. Biome clean.

### Changed
- **`packages/tools/src/git/git.ts`** — schema is now a
  `z.discriminatedUnion('op', [...]).strict()`. Each variant
  declares exactly the field set it's supposed to have:
  - `op: 'status'` — no payload
  - `op: 'diff'` — `ref` / `ref2` / `maxBytes`
  - `op: 'log'` — `ref` / `maxCount` / `maxBytes`
  - `op: 'branch'` — `ref`
  - `op: 'commit'` — `message` (required) / `stageAll` (optional)
- **`.refine()` at the bottom of the old schema**: removed.
  The discriminated union enforces the contract structurally.
- **`ConfigError` defense-in-depth in `case 'commit':`**:
  removed. `input.message` is now `string` in that branch
  (not `string | undefined`), so the type-narrow eliminates
  the need for the runtime check.
- **`ConfigError` import in git.ts**: removed (was the only
  use).
- **`packages/tools/test/git.test.ts`** — added test
  "rejects field set that does not match the chosen op
  (discriminated union)" covering three cases the old
  schema would have silently stripped: `op: 'log' + message`,
  `op: 'commit' + ref`, `op: 'status' + ref`.

### Decisions
- **`.strict()` on every variant**, not `passthrough`. The
  old schema's silent-stripping was the footgun being fixed
  — wrong field on wrong op should throw, not vanish.
- **Did not tighten `message.max(4096)` or `ref.max(256)`**.
  Those were already in the old schema and reviewed in P10.
- **Did not add a `maxCount` to `branch` / `diff`**. The git
  CLI doesn't expose a `--max-count` on those ops; adding
  the field would require implementing truncation. Out of
  P16 scope.

### Notes
- **No version bump**: schema is a stricter form of the same
  contract; existing valid inputs still work.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P15 better-sqlite3 native rebuild automation

**Totals:** 1 commit (`0a75e2b`), 2 files modified, +13/-2 lines,
no test count change (961 → 961), 12 packages, 56 commits on `main`.
Typecheck clean. Biome clean.

### Added
- **`pnpm.onlyBuiltDependencies: ["better-sqlite3"]`** in the
  root `package.json`. pnpm blocks install scripts by default
  (supply-chain hardening). Whitelisting *just* `better-sqlite3`
  lets the package's own `install` hook run on every
  `pnpm install`, which re-downloads the prebuild that matches
  the current Node ABI. The whitelist is minimal and audited —
  no other package's install script runs.
- **`pnpm rebuild:native`** script at the root, which wraps
  `pnpm rebuild better-sqlite3 --filter @lumen/memory`. This
  is the fallback when the prebuild doesn't match (rebuilds
  from source via node-gyp; ~30s on M-series Macs).
- **`docs/L1-AUDIT.md`** updated to reference the new script
  with a one-liner copy-paste for the "I just upgraded Node
  and tests are broken" case.

### Decisions
- **Whitelist, not blanket allow.** Single-element allowlist
  keeps pnpm's supply-chain protection; we trust *this one*
  package's install script.
- **No `postinstall` in `@lumen/memory` itself.** The package's
  own `install` script (whitelisted to run) already handles
  prebuild download. Adding a redundant `postinstall` would
  force a slow from-source rebuild on every install.
- **Root-level `rebuild:native`, not package-level.** Future
  native deps (e.g. `sqlite-vec`'s Rust binding) can be added
  to the same `onlyBuiltDependencies` list and the same
  `rebuild` script without changing the package-level scripts.

### Notes
- **No version bump**: tooling only, no public API change.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P14 Sweep redundant `!` outside @lumen/llm

**Totals:** 1 commit (`cb06032`), 5 files modified, +48/-17 lines,
no test count change (961 → 961), 12 packages, 55 commits on `main`.
Typecheck clean. Biome clean.

### Fixed
- **`packages/config/src/loader.ts` (lines 109-120)** — replaced
  `path[path.length - 1]!` and `path[i]!` with const binding +
  explicit `undefined` check. The `noUncheckedIndexedAccess`
  option then propagates the type safely without the assertion.
- **`packages/memory/src/sqlite-store.ts:546`** — hoisted
  `query.embedding!` (redundant after truthy check) to
  `const r = query.embedding`; also pulled `.sort()` out of the
  chained call so the data flow is obvious.
- **`packages/tools/src/git/git.ts:234`** — `input.message!` was
  papering over the Zod schema's `optional()`. Replaced with
  local const + typed `ConfigError` defense-in-depth check
  (unreachable per the schema's `.refine()` but documents the
  invariant for the next reader).
- **`packages/llm/README.md` (2 sites) + `packages/core/README.md`
  (1 site)** — the apiKey `!` footgun that P12 cleaned from
  JSDoc also lived in two README quick-start snippets.
  Replaced with the same `if (!apiKey) throw new Error(...)`
  guard pattern.

### Sites left alone (real invariants, not footguns)
- `git.ts:161`, `gh.ts:105`, `default-sandbox.ts:148`,
  `terminal.ts:170`: `execArgv[0]!` / `request.command[0]!`
  sit on real invariants (Zod schema enforces `min(1)` array
  length).
- `default-sandbox.ts:89` `buf[end]!`: `while (end > 0 && ...)`
  guards `end > 0`.
- Test fixtures: `!` in those strings is a test-data
  exclamation, not a TS operator.

### Notes
- **No version bump**: internal hardening, no public API change.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P12 Redundant `!` cleanup in @lumen/llm

**Totals:** 1 commit (`ade82fd`), 5 files modified, +23/-18 lines, no
test count change (947 → 947), 11 packages, 49 commits on `main`.
Typecheck clean. Biome clean.

### Fixed
- **3 JSDoc quick-start examples** in `mistral.ts:276`,
  `llm/index.ts:31, 42` showed `apiKey: process.env.X!` — a type-only
  assertion that silently passes `undefined` at runtime when the env
  var is unset. Replaced with the standard `if (!apiKey) throw new
  Error('X is required')` guard pattern in all 3 examples.
- **7 real-code sites** in `openai-compatible.ts:380, 478`,
  `anthropic.ts:462, 464`, and `ollama.ts:417, 420, 619` used
  `cond ? { x: expr! } : {}` with a redundant non-null assertion after
  a truthy check. The check already narrowed the type; the `!` was a
  no-op that also hid a double call to the same mapper. All 7 sites
  refactored to the `const x = expr; ...(x ? { x } : {})` shape — single
  call, shorthand property name, no assertion.

### Notes
- **No version bump**: pure refactor, no public API change.
- **`noNonNullAssertion` rule** stays disabled (P9.0 decision) — this
  pass targets the *redundant* subset only. Legitimate `!` in
  `packages/core/src/agent/pool.ts` (P9.4 circuit breaker) and similar
  sites is preserved.
- **Push status:** same — remote unreachable, no retry.

## [0.9.0] — 2026-06-16 — P8 Release prep

**Totals:** 3 commits (1a647ca, 58e6ee1, f8943a3), 24 files total,
~+823 lines, 0 test delta, 0 code delta. Typecheck clean. Biome clean.

### Added
- `CHANGELOG.md` (this file) — Keep-a-Changelog-style P0–P8 narrative
  with commit SHAs, test-count deltas, and migration notes for the
  P7 source-incompatible changes.
- **Package-level READMEs.** Every package under `packages/` ships
  its own `README.md`. `@lumen/core` / `@lumen/llm` / `@lumen/memory`
  get full READMEs with the public surface, quick start, and code
  samples; the other 7 get shorter role + endpoint-matrix +
  quick-start READMEs. README in the repo root also gains an
  updated test count (566 → 887).
- **npm descriptions on 7 packages.** `package.json` `description`
  field added to `@lumen/config`, `@lumen/core`, `@lumen/llm`,
  `@lumen/mcp`, `@lumen/memory`, `@lumen/skills`, `@lumen/tools`.
  The other 3 (`@lumen/desktop-bridge`, `@lumen/editor-bridge`,
  `@lumen/server`) already had descriptions.

### Changed
- `docs/ARCHITECTURE.md` updated: `BaseVectorMemoryStore`,
  `BaseProviderPool`, `BaseMutex` added to the base-contracts table.
  Adjacent-bridges section documents `@lumen/server`,
  `@lumen/desktop-bridge`, `@lumen/editor-bridge`. A new "No
  global locks" item under "What is intentionally NOT in core"
  documents the `concurrency` module without claiming a global
  re-entrant lock.
- **All 11 packages bumped to 0.9.0** (was 0.1.0 across the board).
  The version now reflects P0 → P8 progress. All packages remain
  `"private": true` — this is a documentation-grade version bump,
  not a publishable release.

### Fixed
- 4 pre-existing Biome format issues in `package.json` files
  (`files: ["dist"]` inline; trailing newline) for `@lumen/mcp`,
  `@lumen/server`, `@lumen/desktop-bridge`, `@lumen/editor-bridge`.

## [0.8.0] — 2026-06-16 — P7 Framework internal cleanup

**Totals:** 2 feature commits / 1 chore, 4 new files / 12 modified, +767
lines, +12 tests (875 → 887), 81 test files, 11 packages, 74 commits on
`main`. Typecheck clean. Biome clean.

### Added
- **`BaseVectorMemoryStore` (P7.1, commit `a53e80c`).** New abstract class
  in `packages/core/src/memory/index.ts` that extends `BaseMemoryStore` with
  an `abstract vectorSearch(embedding, k?)`. Replaces the banned
  duck-typing pattern in `packages/memory/src/retriever.ts`. `SqliteStore`
  now extends `BaseVectorMemoryStore`; the retriever's constructor
  parameter type is narrowed from `BaseMemoryStore` to
  `BaseVectorMemoryStore` so the "supports vectors" question becomes a
  compile-time check.
- **Concurrency module (P7.2, commit `c8f11e0`).** New
  `packages/core/src/concurrency/` directory ships `BaseMutex`, the
  concrete `Mutex` (FIFO promise-chain), `MutexOptions`, and
  `AcquireTimeoutError extends AgentError`. Public extension surface for
  code that needs to serialize state across `await` points.
- **ProviderPool round-robin cursor safety (P7.2).**
  `ProviderPool.candidatesFor` is now `async` and runs inside
  `mutex.runExclusive(...)`, making the read-modify-write of
  `roundRobinIndex` atomic. `register` / `unregister` stay synchronous
  (JS single-threaded event loop makes check+mutate atomic without a
  lock). New regression tests: 3 concurrent `chat` calls verify union
  coverage; 60 concurrent calls verify strict round-robin distribution
  (each provider hit 20 times).

### Changed
- `ProviderPool.candidatesFor` is now `Promise<ReadonlyArray<BaseProvider>>`
  (was `ReadonlyArray<BaseProvider>`). `runWithFailover` and the stream
  path now `await` it. This is source-incompatible for any caller that
  directly invoked `candidatesFor` (none in the public API — it is
  `private`).
- `HybridRetriever.store` field type narrowed from `BaseMemoryStore` to
  `BaseVectorMemoryStore`. This is type-incompatible for any caller that
  passed a `BaseMemoryStore` that is not a `BaseVectorMemoryStore`. Use
  `TextOnlyRetriever` for that case.

### Fixed
- `ProviderPool` round-robin cursor race: under concurrent `chat` /
  `stream` calls the cursor's RMW was non-atomic, occasionally routing
  the same provider twice or skipping one. Now serialized through the
  pool's private `Mutex`. The 60-concurrent-call test fails on the
  pre-P7.2 implementation.
- `Mutex` waiter counter double-decrement bug: the first implementation
  decremented `waiters` on both the success path (when the holder
  releases) and the `finally` block, causing `pending` to report a value
  one lower than the actual queue depth. Fixed by redefining `waiters`
  as queue-total depth (including the holder) and exposing `pending` as
  `waiters - (held ? 1 : 0)`.

## [0.7.0] — 2026-06-15 — P6 Composable layers

**Totals:** 3 feature commits / 1 chore, +1,707 lines, +39 tests
(836 → 875), 71 commits. Typecheck clean.

### Added
- **P6.1 RAG pipeline (commit `631fd99`).** `BaseRagPipeline` abstract
  contract + `RagPipeline` default in `@lumen/memory`. Composes
  caller-supplied `ChunkerFunction`, `TextEmbedder` (P5.1), and
  `BaseVectorBackend`. `ingest` is idempotent (re-ingest replaces prior
  chunks atomically); `retrieve` returns `Citation[]` with offsets and
  scores. +10 tests.
- **P6.2 Local-inference providers (commit `7966591`).** `LlamaCppProvider
  extends OpenAICompatibleProvider` for llama.cpp's OpenAI-compatible
  HTTP server. Default `baseUrl` `http://127.0.0.1:8080/v1`, no required
  `apiKey`. Ollama E2E fixtures add +5 streaming tests (multi-delta
  coalesce, 5xx mid-stream, heartbeat skip, multi-turn round-trip,
  system message at position 0). +6 llama-cpp + 5 ollama tests.
- **P6.3 ProviderPool (commit `75b46bd`).** `BaseProviderPool extends
  BaseProvider` + `ProviderPool` default in `@lumen/core`. Four
  strategies: `round-robin`, `name` (pin to specific id), `capability`
  (filter by capability flags), `weighted` (weighted random with
  injectable PRNG). `runWithFailover` walks strategy-ordered candidates
  and collects `ProviderError` into a `PoolExhaustedError` carrying the
  full `attempts` array. Stream failover is best-effort: commit on
  first yielded event. Capabilities are OR-merged; `maxContextTokens`
  takes the max. +18 tests covering all 4 strategies, failover paths,
  stream commit-on-first-event, and the `PoolExhaustedError instanceof
  AgentError` chain.

## [0.6.0] — 2026-06-15 — P5 Embedding, chunking, and provider tests

**Totals:** 4 feature commits / 1 chore, +1,489 lines, +46 tests
(790 → 836), 67 commits. Typecheck clean.

### Added
- **P5.1 Embedding bridge (commit `ec2118e`).** `EmbeddingSource`
  structural type in `@lumen/memory` that the retriever accepts. No
  `@lumen/llm` import — keeps `@lumen/memory` provider-agnostic.
- **P5.2 `chunk_text` (commit `90ac781`).** New tool in `@lumen/tools`
  with char / paragraph / sentence splitting strategies and overlap
  support. CJK punctuation (`。！？`) is recognized as a sentence
  terminator with or without surrounding whitespace.
- **P5.3 Mistral streaming + tool_use E2E (commit `85058c5`).** +5
  fixtures.
- **P5.4 Anthropic prompt caching (commit `b2957f7`).**
  `AnthropicSystemBlock` / `AnthropicCacheControl` interfaces plus
  `anthropicSystemBlocks` / `anthropicCacheTools` `providerOptions`
  channels. `AnthropicSystemBlockSchema` Zod validation. +6 tests.

## [0.5.0] — 2026-06-15 — P4.3 Mistral provider

**Totals:** 1 commit, +0.5 commit, 62 commits, 790 tests.

### Added
- **P4.3 Mistral provider (commit `fd74df0`).** `MistralProvider extends
  OpenAICompatibleProvider`, overrides `embed()` to POST against
  `/v1/embeddings` with `mistral-embed`. Capabilities `vision: true`
  (Pixtral family). Pre-P4.3 baseline: 74 files / 790 tests / 0 fail.

## [0.4.0] — 2026-06-15 — P4 Web + Google Gemini

### Added
- **P4.1 Web search + fetch (commit `62853b5`).** `@lumen/tools` adds
  `web_search` and `web_fetch`.
- **P4.2 Google Gemini provider (commit `93df03d`).** First-class
  provider in `@lumen/llm`.

## [0.3.0] — 2026-06-12 — J/K/L/M Bridge packages + cross-cutting

### Added
- **`@lumen/server` (commit `d9a0dc0`).** HTTP + WebSocket adapter.
- **`@lumen/desktop-bridge` (commit `97791a4`).** Tauri IPC.
- **`@lumen/editor-bridge` (commit `cf78262`).** VSCode + JetBrains
  editor adapter.
- **Sub-agent delegation (commit `bdd7cc0`).** `K1.x` — orchestrator
  can spawn child agents with isolated context.
- **Security audit module (commit `bdd7cc0`).** `M4.x` — dangerous
  command and PII detection.
- **Cron scheduler (commit `bea3932`).** `K2.x` — scheduled job
  registry with notification delivery.
- **Plan/act mode (commit `b249162`).** `K3.x` — explicit two-phase
  agent loop (read-only planning, then tool-bearing execution).
- **Multi-user collaboration (commit `02e42f8`).** `K4.x` — namespace
  isolation across users.
- **Telemetry collector (commit `e2cc9e5`).** `H3.x` — opt-in usage
  metrics with redacted payloads.
- **`lumen` doctor `--verbose` / `update` (commit `df7bfc0`).** `I7.x`.
- **Model / config / tools subcommands (commit `c3a422d`).** `I6.x`.

## [0.2.0] — 2026-06-08 — H/I E/F Working memory + reflection

### Added
- Working memory ring buffer (E9.x — `0f3cda0`).
- Cross-session retriever (E10.x — `ccfbb98`).
- Pluggable vector backend with sqlite-vec + brute-force fallback
  (E8.x — `c4603f2`).
- Reflection + fact extraction (E8.x — `8c1c059`).
- Conflict detection in memory (E9.x — `6a4d946`).
- Skill triggering (keyword + embedding) (F3.x — `f323eb5`).
- Skill auto-evolution (F4.x — `90c241e`).
- Trajectory hook for self-creating skills (F5.x — `0cbf364`).
- Long-term user profile builder (E7.x — `8392572`).
- Docker sandbox (D12.x — `ad8d418`).
- Toolset grouping + lazy loading (D11.x — `f5dd425`).
- Structured logging: `BaseLogger` / `ConsoleLogger` / `PinoLogger`
  (H2.x — `04636f0`).
- MCP Streamable HTTP transport, MCP 2025-03-26 spec
  (`55301cc`).
- `gh` CLI bridge for PR/issue operations (D9.x — `45389a8`).
- Date / env / whoami meta tools (D10.x — `bb62354`).

## [0.1.0] — 2026-06-08 — Bootstrap (P0 / P1 / P2 / P3)

### Added
- **P0 Bootstrap.** Monorepo + pnpm workspaces + turborepo.
  `docs/ARCHITECTURE.md`, `docs/DEVELOPER.md`, `docs/SECURITY.md`,
  `docs/L1-AUDIT.md`, `tsconfig.base.json` (strict + noUncheckedIndexedAccess),
  Biome config, `Dockerfile`. `@lumen/config` MVP (YAML load + profile
  switch). `BaseProvider` / `BaseTool` / `BaseMemoryStore` / `BaseSkill`
  / `BaseTransport` contracts. `Agent` runtime with 26 unit tests.
- **P1 Tools.** Filesystem tools (read/write/patch/list/search) — 27
  tests. Terminal + Git tools with `ShellSandbox` (D7–D13).
  Streaming: `Agent.streamRun` yields `RunEvent` generator; TUI
  renders deltas. Ink/React TUI chat with state machine + composition
  root. MVP CLI: `run` / `doctor` / `chat` (6 tests).
- **P2 Memory.** `InMemory` + `Sqlite` stores with FTS5 / WAL, contract
  test suite, CLI wiring.
- **P3 Skills / MCP.** Markdown skill registry + CLI integration. MCP
  stdio transport + `lumen doctor` round-trip. `OpenAICompatibleProvider`
  (10 tests). Anthropic Messages API provider (C4.x). Ollama local
  provider (C5.x).
