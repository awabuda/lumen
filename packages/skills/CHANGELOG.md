# @lumen/skills

## 0.18.0

### Minor Changes

- aa18d4a: P52.a — `SkillRegistry.applyActive` now substitutes
  `${ARG[i]}` / `${ARGUMENTS}` placeholders in the
  skill's `instructions` text with the positional
  args supplied via `ctx.arguments`. The pre-P52.a
  path did not parameterise skill templates. The
  operator could not call a skill with positional
  args (e.g. `/code-review <branch>`).

  Placeholders supported:

  - `${ARG[0]}` / `${ARG[1]}` / ... — indexed
    positional substitution.
  - `${ARGUMENTS}` — joins the array with spaces
    (the pre-P52.a Claude Code convention).
  - Out-of-range placeholders are left
    untouched (the operator should see the
    raw `${ARG[1]}` in the output so they can
    fix the invocation).

  The `SkillContext` schema gains an
  `arguments: string[]` field. The
  `SkillRegistry.applyActive` returns substituted
  instructions when `ctx.arguments !== undefined`.
  The `BaseSkill.apply(ctx)` interface is
  unchanged (the substitution happens upstream,
  in the registry) — this keeps the per-skill
  contract stable.

  Bug.md #67 follow-up. Test counts: skills
  63 → 67 (+4); monorepo 1959 → 1963 (+4).
  0 regressions introduced (7 pre-existing
  failures + 1 tools pre-existing failure
  remain FENCE-OFF).

## 0.17.0

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

## 0.16.0

### Minor Changes

- cd89661: P23.10: tools / security / skill-quality fixes from the bug.md audit (fix #12, #13, #19, #33, #35, #36, #45, #46). Highlights:

  - #12 `buildRestrictedRegistry` now warns (via the optional logger) when an `allowedTools` entry has no match in the source registry; previously the entry was silently dropped and the sub-agent ran with fewer tools than the caller intended. The logger param is forwarded from `createSubAgent` → `buildAgent` → `buildRestrictedRegistry`.
  - #13 `ProviderPoolOptionsSchema` now exposes the `circuit` field that the interface already accepted. Pre-P23.10 a caller who wired `circuit` through `Schema.parse(cfg)` had it silently stripped — the pool ran without a breaker.
  - #19 `ToolRegistry.materializeToolset` logs at `console.debug` when a tool name already exists, naming the duplicate toolset so an operator can resolve the conflict without grepping. The first-wins policy is preserved.
  - #33 `IntervalCron.run` and `OnceCron.run` add a `_running` re-entry guard. The doc-flagged `isRunning` getter reflects the scheduler's timer state, not the in-progress job; the new flag is local to `run()` and cleared in `finally`.
  - #35 `SkillRegistry.activate()` and `applyActive()` run in parallel via `Promise.all` — `shouldActivate()` and `apply()` are read-only against `ctx`, so the parallelism is safe.
  - #36 `globLikeMatch` skips the `^` / `$` anchors when the pattern contains `*` so `'foo*'` matches `'foobar/baz'` and `'*foo*'` matches `'myfoobar'`. Literal (no-`*`) patterns still anchor.
  - #45 `createTrace` throws `ValidationError` (was a generic `Error`) so callers can `instanceof`-discriminate validation failures from other runtime errors.
  - #46 `HookRegistry` accepts an optional `BaseLogger`; hook exceptions are routed through `logger.error` instead of `console.error` when one is provided. The default behaviour is preserved.

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
