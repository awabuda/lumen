# @lumen/core

## 0.17.0

### Minor Changes

- bcf1501: P23.6: Cost and time budget limits are now wired end-to-end (bug #8). Pre-P23.6 the `Budget` constructor accepted `costUsd` and `timeMs` but `Agent.run` never read either from `AgentRunOptions` — the Budget was constructed with only `tokens`. `Budget.addCost()` existed but no caller invoked it, and `usage.costUsd` had no schema field. This commit adds `costLimitUsd` and `timeLimitMs` to `AgentRunOptions`, threads them into the Budget constructor, extends `AssistantMessage.usage` with optional `costUsd`, and wires `budget.addCost(usage.costUsd)` after each model call on both the sync and stream paths. Pre-existing token-limit behaviour and the "no limit" default are preserved.
- f369f53: P23.5: Checkpoint save failures now log a structured warning (bug #7). Pre-P23.5 the `catch {}` block in `saveCheckpointBestEffort` silently swallowed persistence failures; users resuming after a crash had no way to tell whether the run crashed, the checkpoint save crashed, or both. The catch now calls `BaseLogger.warn` with `{ sessionId, iterations, outcome, error, errorName }`. The best-effort contract is preserved: the run result and the original error are never replaced by a checkpoint failure. All 4 call sites in `Agent.run` thread `this.logger` into the helper.
- e68c610: P23.3: Middleware state mutation now goes through the typed `MiddlewareStateView.set()` writer (bug #4 + #15 in the bug.md audit). `ctx.stateView` exposes one `MiddlewareStateView` entry per middleware; `set(next)` re-parses against the owning middleware's `stateSchema` (throwing `MiddlewareError` on violation) and persists into the merged state dictionary so changes survive across iterations. `plan.ts` and `reflection.ts` migrated from the cast-and-mutate footgun (`state.plan = X`, `state.stepCount += 1`) to `stateView.<name>.set(next)`. Writes from one middleware into another's slice fail closed at runtime because each `set` callback is closed over the owning schema.
- 71316da: P23.7: Parallel tool dispatch + ParallelSubAgent real streaming (bug #9 + #23). `AgentRunOptions.parallel?: boolean` opts into concurrent tool-call dispatch via `Promise.all` when a model response has > 1 tool call. tool:start events fire up front in invocation order; tool:end events fire as each completes. Default false preserves serial behaviour. `ParallelSubAgent.stream()` now yields each task as it settles (Promise.race against a tagged Map) instead of waiting for `Promise.allSettled` and iterating in invocation order. Pre-P23.7 `stream()` was functionally identical to `run()` for any caller that awaited one entry at a time.
- 4b30e7e: P23.4: Middleware can now read the full conversation history at any hook point (bug #5). `MiddlewareContext.history: ReadonlyArray<Message>` is attached on `beforeModel`, `wrapModelCall`, `afterModel`, and `afterRun` (with the just-produced message included on `afterModel`). `ReflectionMiddleware.afterModel` and `afterRun` now read `ctx.history` instead of `[message]` — pre-P23.4 the heuristic collapsed every run to "1 message, 0 tools, 0 errors" regardless of length. The new seam is back-compat-friendly: pre-existing middleware that doesn't touch `ctx.history` keeps working unchanged.
- 76c5cfc: P23.9: small correctness fixes across the audit (fix #11, #25, #26, #27, #28, #29, #30, #31, #41). Highlights: `mergeArgs` uses a `Symbol` for the raw-string slot so a tool arg literally named `__raw__` no longer collides (#11); FTS5 tokenisation preserves CJK + accented characters (#25); `PlanSchema` enforces mutex on `approvedAt` / `rejectedAt` (#29); `ClusterOptionsSchema` is now exported (#30); the `MinimalProvider` interface in `core/src/plan/index.ts` tracks `BaseProvider.chat`'s real signature so mocks pass at runtime (#31); `createProviderEmbedder` forwards `dimensions` (#32, also covered by P23.8); `persistExtractedFacts` parallelises the dedup + put path (#26); `HttpMcpTransport` lazy-validates `fetch` instead of throwing in the constructor (#27); the OpenAI-compatible stream emits a generated id when the upstream omits one (#28); `WebFetchTool.execute()` drops the redundant `text.slice(0, parsed.maxBytes)` — the truncated flag is computed against the original length (#41).
- f11a82b: P23.2: Sub-agents now inherit the parent's middleware list (bug #2 + #14 in the bug.md audit). `createSubAgent` and `createSubAgentFromSpec` route through `createAgent` when a non-empty `parentMiddleware` list is supplied; the handoff and supervisor sub-agent paths forward `parent.middleware` through the same channel. The behaviour is strictly additive: omitting the new arg preserves the pre-P23.2 path exactly.
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

- Updated dependencies [17346c7]
  - @lumen/config@0.16.0
