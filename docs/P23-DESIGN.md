# P23 design lock — bug.md audit fix sweep

> **Design-only pass.** P23 closes the 53 verified real
> bugs in `bug.md` (21-22 audit review) plus 8 PARTIAL
> claims. P19+ rule 16 mandates a 4-framework real-URL
> fetch + 6-question audit + decision list before any
> code lands. The fix shape, the framework comparison,
> and the design constraints are all locked here. The
> first P23.x implementation commit is the next step.

## 0. Why P23

### 0.1 Source

`bug.md` (working tree, untracked at session start) lists
103 numbered issues. The author did the audit on
2026-07-15 against `packages/core/`, `packages/llm/`,
`packages/memory/`, `packages/mcp/`, `packages/skills/`,
`packages/tools/`, and `packages/core/src/hooks/`.

### 0.2 P23 audit (post-audit re-verification)

| # | Verdict | Note |
|---|---------|------|
| 1-46 | **46 issues, 41 CORRECT + 2 PARTIAL + 1 INCORRECT + 2 from prior session** | see §1 |
| 47-53 + 84-103 | **27 issues, 19 FEATURE_GAP + 6 PARTIAL + 1 INCORRECT + 1 missing** | out of scope |
| 54-83 | **30 numbers missing** | bug.md 编号跳号 |
| bug.md 自身 | **3 internal bugs** (编号错位 + 编号缺失 + markdown 标题重复) | n/a |

**53 verifiable bugs (41+2+8+2=53): all actionable, none
fabricated.** bug.md is a real audit. The 2 INCORRECT
items (#17 PoolExhaustedError undefined, #88 无图像支持)
are P23+ audit tasks to fix in bug.md itself, not in
lumen code.

### 0.3 4-framework fetch verification (2026-07-15)

| Framework | URL fetched on 2026-07-15 | Key takeaway for P23 |
| --- | --- | --- |
| **LangChain 1.0 middleware** | `https://docs.langchain.com/oss/javascript/langchain/middleware/overview` (re-fetched 2026-07-15) | **Middleware is "hooks run inside the compiled LangGraph"** (page leads with: "Middleware is not a separate runtime: hooks run inside the compiled LangGraph that `create_agent` returns"). State is implicit in the LangGraph state graph; the docs do not show a `set()` API for middleware — middleware mutates via standard LangGraph state reducers. The custom-middleware page exposes `beforeModel` / `afterModel` / `wrapModelCall` / `wrapToolCall` hooks as functions that take the runtime + state and return modified values. **No precedent for lumen-style `MiddlewareStateView.set()`.** |
| **LangGraph subgraphs** | `https://docs.langchain.com/oss/javascript/langgraph/graph-api` (re-fetched 2026-07-15) | **Subgraphs are first-class node types**: a parent `StateGraph` can include a compiled subgraph as a node, and the subgraph's state schema is a strict subset of the parent's. `Command.PARENT` is the explicit way for a subgraph to address the parent graph. State updates from a subgraph to a parent require explicit **reducers** in the parent schema (a key callout in the docs). **The subagent-inherits-middleware pattern is handled at the graph-composition level, not at the sub-agent-config level.** |
| **Claude Code sub-agents** | `https://docs.claude.com/en/docs/claude-code/sub-agents` (re-fetched 2026-07-15) | **"Each [sub-agent] inherits the parent conversation's permissions with additional tool restrictions"** (page leads with this). The sub-agent frontmatter includes `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode` (default/acceptEdits/auto/dontAsk/bypassPermissions/plan/manual), `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory` (user/project/local), `background`, `effort`, `isolation: 'worktree'`, `color`, `initialPrompt`. **This is the direct precedent for lumen sub-agent config**: a per-sub-agent table of fields that override the parent's. The page does not document an `addCost` / `costLimit` field — that is lumen-internal. |
| **OpenClaw** | `https://openclaw.ai/blog` (re-fetched 2026-07-15) | The blog has no public surface for sub-agent composition or middleware state mutation. OpenClaw's documented hardening (SkillSpector scan, VirusTotal partnership, "Safer Than YOLO" auto-mode) is at the policy layer, not the framework layer. **No precedent for lumen sub-agent inheritance.** |

**Synthesis**: Claude Code's sub-agent frontmatter is the
**direct precedent** for the lumen fix shape. lumen
already has the right plumbing (sub-agent frontmatter
config, `createAgent` factory, `BaseAgentMiddleware`) —
the fix is to **add the missing fields and wire them**.
LangGraph subgraphs are the architectural alternative
(treat sub-agent as a state graph node) but that is a
P24+ refactor, not the right fix for the current
sub-agent-bypasses-middleware footgun.

LangChain 1.0's `useMiddleware` + middleware-as-function
pattern is **the wrong shape for lumen**: lumen has an
explicit `MiddlewareStateView` + `set()` contract
(stronger than LangChain's read-only pass-through). The
fix for bugs #4 and #15 is to **actually use the
contract lumen already ships** — not to redesign it
to match LangChain.

### 0.4 6-question audit (post-P22.6, post-bug-audit)

| # | Question | Lumen status (post-bug-audit) | Gap? |
| --- | --- | --- | --- |
| 1 | Skill | full (P20.6) | full |
| 2 | Team | full (P19.3/4 + P20.7) | full |
| 3 | Workspace | full (P20.4 + P21.2) | full |
| 4 | Context | full (P6/P9) | full |
| 5 | Failure | full (P21.0/P21.1) | full |
| 6 | Security + Risk | full (P22.0 + P22.5) | full |
| 7 | Composition | full (P22.6) | full |
| 8 | Build hardening | full (P15 + P22.7) | full |
| 9 | **Correctness** | full (P0-P3 ship 0/0) | **partial → full with P23** |
| 10 | **Audit hygiene** | partial (bug.md 自身有编号/标题 bug) | **partial → full with P23** |

The new **correctness** axis is the rationale. P22
shipped permission/auto-mode/composition as features;
P23 ships the audit fixes that were surfaced by the
bug.md review. The new **audit hygiene** axis is the
second rationale — bug.md has 3 internal bugs that P23
should fix as part of the audit cycle (the corrected
`bug-fixed.md` will be the canonical record).

### 0.5 Why P23 is the right slot (not P24+)

- **It is the natural follow-up to a P22-pass audit.**
  P22.6 (commit `f8760ba`+`77c7ef7`+`3807a61`+`6d30679`+`c511af2`)
  shipped permission cross-policy composition. The
  audit during that pass surfaced `bug.md`; the fix
  pass is P23.
- **The user explicitly asked for "全部修复" (all
  fixes).** Treating 53 verified bugs as backlog would
  directly contradict the user's instruction. P24+
  scope (the 19 FEATURE_GAP items) is excluded.
- **The fix surface is small per sub-ticket.** Each P23.x
  sub-ticket is 30-200 lines of code + 1-2 tests + 1
  changeset. Mirrors the P22.6 / P22.5 / P22 shape
  (4 sub-tickets each).
- **Two of the bugs (#1, #2) are security-critical.**
  The audit found that `streamRun` and `sub-agent.run`
  bypass permission middleware. A deployed lumen with
  permission policies on `lumen run` is silently
  unprotected on `lumen run --stream` or
  `sub-agent.call`. This is a CVE-class footgun.

## 1. P23 issue list (the 41 + 2 + 2 + 8 = 53 fix items)

### 1.1 P0 (security + correctness, 5 issues)

- **#1 streamRun bypasses middleware** — `agent/index.ts:520-761` calls `this.provider.stream()` + `this.dispatchToolCall()` directly; the middleware chain (`callProviderWithMiddleware` / `callToolWithMiddleware` / `applyBeforeModel` / `applyAfterModel` / `applyAfterRun`) is only used in `run()`. Fix: extract the common loop (see #3) so `streamRun` and `run` share the same per-iteration pipeline.
- **#2 sub-agent uses `new Agent` not `createAgent`** — `agent/sub-agent.ts:104` calls `new Agent({...parent, tools, ...})` directly, bypassing `createAgent`'s middleware injection. Fix: switch to `createAgent` and add `middleware` to the `parent` config (see #14).
- **#6 sessionId always empty string** — `agent/index.ts:948` passes `sessionId: ''` to `tool.call()`. The real sessionId is computed at line 274 but not threaded into `dispatchToolCall`. Fix: add a `sessionId` parameter to `dispatchToolCall` and thread it from the run options.
- **#10 ToolCall ID hardcoded to 0 in streamRun** — `agent/index.ts:599` reads `toolAcc.get(0)` and `:609` writes `toolAcc.set(0, merged)`. The `key` variable (line 598) is computed but never used. Fix: use `key` as the map key.
- **#15 interrupt / tool-permission / auto-mode use closure variables** — all three middlewares declare `stateSchema` + `initialState` but write decisions to a closure-scoped array instead of `MiddlewareStateView.set()`. Fix: replace `decisions.push(...)` with `ctx.state.set(...)` and read the decisions through `ctx.state.get()`.

### 1.2 P1 (correctness + architecture, 6 issues)

- **#3 run/streamRun duplicate ~90% of their body** — `agent/index.ts:268-498` vs `:520-761` share the initialization, signal check, message seeding, Budget construction, memory seeding, and the iteration loop scaffold. Fix: extract `executeLoop(options, mode: 'sync' | 'stream')` to a private method. `run()` and `streamRun()` become thin adapters that drive the loop in the right shape.
- **#4 middleware state mutated directly (plan + reflection)** — `middleware/plan.ts:94,109` and `middleware/reflection.ts:89-90` cast the state via `stateFrom` and then mutate. The `MiddlewareStateView` interface (middleware.ts:144) has a `set()` method that is never called. Fix: use `ctx.state.set(next)` everywhere; `stateFrom` becomes a thin Zod-parsing helper.
- **#5 Reflection only sees one message** — `middleware/reflection.ts:91` does `const messages = [message]`. Fix: thread the full message history through `ctx` (the reflection hook signature takes `(message, ctx)`; we add `(messages, ctx)` or pass `ctx.messages`).
- **#7 Checkpoint failures are silently swallowed** — `agent/index.ts:237` `} catch {` is empty. Fix: log a warning via `this.logger.warn('checkpoint save failed', { error, sessionId, iteration })`.
- **#8 Budget cost/time limits not wired** — `agent/index.ts:357,664` only call `budget.addTokens()`; `budget.addCost()` is never called and the `timeMs` / `costUsd` limits in `BudgetLimits` are unreachable in practice. Fix: thread `addCost(usage.costUsd)` (when the provider returns cost), and `isExceeded()` already checks time.
- **#14 `SubAgentMiddlewareOptions.parent` lacks `middleware`** — `middleware/sub-agent.ts:25-30` defines `parent` as `{ provider, tools, model?, cwd? }`. Fix: add `middleware?: ReadonlyArray<AgentMiddleware>` to the type, and pass it through `createAgent` in `sub-agent.ts:buildAgent()`.

### 1.3 P2 (correctness, 12 issues)

- **#9 tool calls serial** — `agent/index.ts:409-422`. Fix: add an opt-in `parallel: boolean` option to `AgentRunOptions` and use `Promise.all` when set.
- **#11 mergeArgs `__raw__` overwrites original field** — `agent/index.ts:180-188`. Fix: switch to a `Symbol` for the raw key.
- **#20 SqliteStore dimension hardcoded 1536** — `memory/src/sqlite-store.ts:206`. Fix: add `dimensions?: number` to `SqliteStoreConfig` and pass it through.
- **#21 SqliteVecBackend.upsertBatch no transaction** — `vector-backend.ts:185-187`. Fix: wrap in `db.transaction(...)`.
- **#22 FNV-1a 32-bit hash collision risk** — `vector-backend.ts:181`. Fix: switch to xxHash64 or a 64-bit FNV-1a variant; or store the original id in a side table.
- **#23 ParallelSubAgent.stream is not real streaming** — `sub-agent-orchestration.ts:175-180` uses `Promise.allSettled` then yields. Fix: use a per-task `push`-based queue that yields as each task settles.
- **#25 FTS5 strips special chars** — `sqlite-store.ts:506`. Fix: use FTS5's `"token"` quote syntax with proper escape for `"` itself.
- **#29 PlanStore allows both approvedAt + rejectedAt** — `plan/index.ts:327-332`. Fix: add a Zod `.refine()` to `PlanSchema` that requires mutex.
- **#32 createProviderEmbedder drops `dimensions`** — `embedder.ts:109-112`. Fix: pass `dimensions: validated.dimensions` to `source.embed()`.
- **#34 SqliteCheckpointStore async-wraps sync** — `sqlite-checkpoint-store.ts:156-189`. Fix: remove `async` from the 6 methods, return `T` / `T | undefined` instead of `Promise<T>`.
- **#39 GitTool doesn't check `ctx.signal.aborted`** — `git.ts:190-196`. Fix: check `ctx.signal.aborted` before `spawn`.
- **#41 WebFetchTool double-truncates** — `web/index.ts:369-370`. Fix: drop the redundant `text.slice(0, parsed.maxBytes)`; the truncated flag is computed correctly upstream in `readCapped`.
- **#40 GitTool passes `process.env` to subprocess** — `git.ts:193`. Fix: filter the env through the same allow-list `DefaultSandbox` uses.

### 1.4 P3 (code quality, 14 issues)

- **#12 buildRestrictedRegistry silently skips unknown tools** — `sub-agent.ts:78-89`. Fix: log a warning when an `allowedTools` entry has no match.
- **#13 ProviderPoolOptionsSchema missing `circuit`** — `pool.ts:127-144`. Fix: add `circuit: z.custom<CircuitBreaker>().optional()` to the schema.
- **#18 middlewareContext is a no-op** — `agent/index.ts:798-800`. Fix: remove (callers use the parameter directly).
- **#19 ToolRegistry silently skips duplicate names** — `tools/index.ts:282`. Fix: log a debug-level message naming the duplicate.
- **#24 ContextCompressionMiddleware has empty state** — `middleware/context-compression.ts:104`. Fix: add `compressionCount`, `lastCompressedAt`, `totalMessagesCompressed` to the state.
- **#26 persistExtractedFacts is serial** — `memory/src/reflector.ts:106-110`. Fix: parallelize with `Promise.all` after a dedup pass.
- **#27 HttpMcpTransport throws in constructor** — `mcp/src/http-transport.ts:135-141`. Fix: lazy-validate on first call.
- **#28 OpenAICompatible.stream tool id can be empty** — `llm/src/openai-compatible.ts:538-539`. Fix: at `message_complete` time, assert `acc.id` is non-empty or generate a UUID.
- **#30 ClusterOptionsSchema not exported** — `memory/src/meta-reflector.ts:77,86`. Fix: `export const ClusterOptionsSchema = z...`.
- **#31 MinimalProvider type is loose** — `core/src/plan/index.ts:140-146`. Fix: import `BaseProvider.chat` and re-use its signature.
- **#33 BaseCron.run has no `isRunning` guard** — `cron/index.ts:125,213,353`. Fix: at the top of each `run()`, early-return if `this.isRunning`.
- **#35 SkillRegistry activate/apply are serial** — `skills/src/registry.ts:64-83`. Fix: `Promise.all` over the skills.
- **#36 globLikeMatch uses `^...$`** — `skills/src/base.ts:167`. Fix: when pattern has `*` segments, use partial match; when not, use full match.
- **#37 TerminalTool re-imports `node:path`** — `tools/src/shell/terminal.ts:31,185`. Fix: use the top-level `path` import.
- **#38 TerminalTool.sandboxTimeoutMs hardcoded 30000** — `tools/src/shell/terminal.ts:244-249`. Fix: cache the timeout in the constructor; the sandbox exposes `getTimeoutMs()`.
- **#42 RingBufferWorkingMemory.append is O(n) shift** — `core/src/memory/working-memory.ts:113-121`. Fix: ring buffer with head index.
- **#43 SessionGate.open is O(n) find** — `core/src/multi-user/index.ts:305-311`. Fix: add `Map<userId, sessionId>` reverse index.
- **#44 DuckDuckGo parse uses regex** — `tools/src/web/index.ts:198-199`. Fix: switch to the DuckDuckGo instant-answer API or accept the brittleness (mark as known limitation in a comment).
- **#45 createTrace uses generic Error** — `core/src/trace.ts:80,83,86`. Fix: throw `ValidationError`.
- **#46 HookRegistry uses `console.error`** — `core/src/hooks/index.ts:69`. Fix: thread a logger through `HookRegistry` and use `logger.error`.

### 1.5 PARTIAL fixes (8 items)

- **#11** is reclassified as PARTIAL (overwrite, not collision).
- **#36** is reclassified as PARTIAL (`*` works fine; only non-`*` patterns are over-anchored).
- **#49** sub-agent memory sharing — PARTIAL: keep as-is, document in `docs/SUB-AGENTS.md` that memory is shared.
- **#85** worktree isolation — PARTIAL: keep as-is, defer to P24 (would require new `BaseWorktree` abstraction).
- **#90** parallel MCP init — PARTIAL: keep as-is (existing `Promise.all` covers the common path).
- **#95** permission modes — PARTIAL: keep as-is (the `auto` mode from P22.5 covers most use cases).
- **#96** apply_patch — PARTIAL: keep as-is; the standard `patch` tool covers most multi-file edits.
- **#101** `/cost` — PARTIAL: defer to P24 (expose `agent.getBudget()`).
- **#103** event bus — PARTIAL: keep as-is; each module's `subscribe` is sufficient for the current user surface.

### 1.6 INCORRECT (2 items — fix in bug.md only, not in code)

- **#17 PoolExhaustedError undefined** — `pool.ts:399,407,415` has the right invariant: `lastError` is assigned on the empty-stream path (line 407) or the catch path (line 415). The only way to reach `throw new PoolExhaustedError(...)` at line 423 is via the `continue` branches, which both assign. The "bug" is theoretical. bug.md should be amended to mark this as INCORRECT.
- **#88 无图像支持** — `core/src/message/index.ts:42-52` defines `ImagePartSchema`. Four providers (`openai-compatible`, `anthropic`, `gemini`, `ollama`) advertise `vision: true` capability. The bug.md claim is INCORRECT. bug.md should be amended to mark this as INCORRECT.

## 2. P23 task breakdown (12 sub-tickets)

P23 ships in **12 sub-tickets** to keep each commit
small and reviewable. The sub-tickets are grouped so
that a sub-ticket that affects multiple files lands all
its files in one commit; cross-cutting refactors (like
#3, the `executeLoop` extraction) are pre-merged into
#1 (since #1 cannot be fixed without #3).

| Sub | Issues fixed | Files touched | Commit shape |
| --- | --- | --- | --- |
| **P23.0** | streamRun middleware parity (uses #3 extraction internally) | `agent/index.ts` | `fix(core): P23.0 — streamRun middleware parity (fix #1 + #6 + #10)` |
| **P23.1** | extract `executeLoop` (pre-req for #1) | `agent/index.ts` | `refactor(core): P23.1 — extract executeLoop() shared by run/streamRun` |
| **P23.2** | sub-agent uses `createAgent` + carries `middleware` | `agent/sub-agent.ts`, `middleware/sub-agent.ts` | `fix(sub-agent): P23.2 — sub-agent inherits parent middleware (fix #2 + #14)` |
| **P23.3** | middleware state via `MiddlewareStateView.set()` | `middleware/plan.ts`, `middleware/reflection.ts`, `middleware/interrupt.ts`, `middleware/tool-permission.ts`, `middleware/auto-mode.ts` | `fix(middleware): P23.3 — middleware state via MiddlewareStateView.set() (fix #4 + #15)` |
| **P23.4** | reflection sees full history | `middleware/reflection.ts` | `fix(middleware): P23.4 — reflection reads full message history (fix #5)` |
| **P23.5** | checkpoint failure logging | `agent/index.ts` | `fix(core): P23.5 — checkpoint failure logs (fix #7)` |
| **P23.6** | budget cost/time wired | `agent/index.ts`, `budget/index.ts` | `fix(budget): P23.6 — wire cost and time limits (fix #8)` |
| **P23.7** | parallel tool dispatch + real streaming | `agent/index.ts`, `agent/sub-agent-orchestration.ts` | `fix(parallel): P23.7 — parallel tool dispatch + ParallelSubAgent real streaming (fix #9 + #23)` |
| **P23.8** | memory correctness (dimension, hash, transaction, embed) | `memory/src/sqlite-store.ts`, `memory/src/vector-backend.ts`, `memory/src/embedder.ts` | `fix(memory): P23.8 — SqliteStore dimension configurable + FNV-64 + upsertBatch transaction (fix #20 + #21 + #22 + #32)` |
| **P23.9** | small correctness fixes | `agent/index.ts` (mergeArgs Symbol), `plan/index.ts` (mutex refine), `mcp/src/http-transport.ts`, `llm/src/openai-compatible.ts`, `memory/src/meta-reflector.ts` (export schema), `core/src/plan/index.ts` (MinimalProvider), `core/src/trace.ts` (ValidationError), `memory/src/sqlite-checkpoint-store.ts` (drop async), `memory/src/reflector.ts` (parallel persist), `tools/src/web/index.ts` (drop double-truncate) | `fix(quality): P23.9 — small correctness fixes (fix #11 + #25 + #27 + #28 + #29 + #30 + #31 + #34 + #26 + #41)` |
| **P23.10** | tools/security | `tools/src/git/git.ts`, `tools/src/shell/terminal.ts`, `tools/src/web/index.ts` (DDG comment), `cron/index.ts`, `tools/src/index.ts` (ToolRegistry warn), `core/src/memory/working-memory.ts` (ring buffer), `core/src/multi-user/index.ts` (userId index), `core/src/hooks/index.ts` (logger), `core/src/agent/index.ts` (remove middlewareContext), `agent/pool.ts` (ProviderPoolOptionsSchema circuit) | `fix(tools/quality): P23.10 — security + small quality fixes (fix #12 + #13 + #18 + #19 + #33 + #35 + #36 + #37 + #38 + #39 + #40 + #42 + #43 + #44 + #45 + #46)` |
| **P23.11** | audit hygiene: fix bug.md itself (mark #17 and #88 INCORRECT, re-number the priority table, add the missing-#54-#83 note) | `bug.md` → renamed `bug-fixed.md` | `docs(audit): P23.11 — fix bug.md audit hygiene (mark #17 + #88 INCORRECT, repair priority table)` |
| **P23.12** | TASKS row | `TASKS.md` | `docs: TASKS — P23 marked done with hashes` |

The order matters: P23.1 (extract `executeLoop`) is a
prereq for P23.0 (streamRun parity). Both must ship
before P23.2 (sub-agent) because P23.2's `createAgent`
call needs the same composition root that P23.0's
`streamRun` uses. P23.3 (state) is independent of the
run/stream sub-area; it can ship in parallel. P23.4-10
are independent of each other and can ship in any
order. P23.11 is the audit-hygiene pass, which
intentionally lands LAST so the verdict is final.

## 3. 4-framework comparison (P23 fix shape)

| Axis | LangChain 1.0 | LangGraph 1.0 | Claude Code | OpenClaw | Lumen (P23) |
| --- | --- | --- | --- | --- | --- |
| Middleware state | LangGraph state via reducers | LangGraph state via reducers | n/a (Claude Code has no middlewares) | n/a | `MiddlewareStateView.set()` (P19 design) — kept; bug was "not used" |
| Sub-agent permissions | per-sub-agent tool restrictions | subgraph parent-state reducers | `permissionMode` field, frontmatter table | none documented | sub-agent `parent.middleware` field (P23.2) + optional `permissionMode` (P24+) |
| Sub-agent worktree | n/a | n/a | `isolation: 'worktree'` field | n/a | deferred to P24 |
| Stream/middleware parity | n/a (no separate stream path) | n/a | n/a | n/a | `executeLoop` shared by run/streamRun (P23.1) |
| Cost budget | provider-level (no agent budget) | n/a | `/cost` command | n/a | `addCost` wired into run loop (P23.6) |
| Parallel tools | n/a | graph branches | n/a | n/a | opt-in `parallel: boolean` (P23.7) |

P23 adopts the **Claude Code sub-agent field-parity**
shape and the **LangChain pass-through state** shape,
rejected the **LangGraph sub-graph-as-node** refactor
(deferred to P24+ because it's a much larger change),
and kept the **lumen `MiddlewareStateView.set()` API**
because lumen already ships it and the bug is "not
used", not "wrong shape".

## 4. Verification plan

4-gate per sub-ticket (P22.6 reference):

- `pnpm -r typecheck` — clean
- `pnpm --filter @lumen/cli exec vitest run` — clean
- `pnpm exec biome check` — clean
- new test files added (2-4 per sub-ticket on average):
  - `packages/core/test/agent/execute-loop.test.ts` (P23.1)
  - `packages/core/test/agent/stream-run-middleware.test.ts` (P23.0)
  - `packages/core/test/sub-agent-inheritance.test.ts` (P23.2)
  - `packages/core/test/middleware/state-mutation.test.ts` (P23.3)
  - `packages/memory/test/sqlite-store-config.test.ts` (P23.8)
  - `apps/cli/test/lumen-doctor.test.ts` updated (existing)

End-to-end verification after P23.0 lands:

```bash
# 1. run() and streamRun() must both invoke permission middleware
node apps/cli/dist/index.js run --permissions test-policy.yaml "delete /tmp/x"
node apps/cli/dist/index.js chat --permissions test-policy.yaml
# 2. Sub-agent must carry parent's middleware
node apps/cli/test/sub-agent-inheritance.test.ts
# 3. Middleware state mutations must be visible through MiddlewareStateView.get()
node packages/core/test/middleware/state-mutation.test.ts
```

## 5. Decision list

1. **Header parse / 4-framework fetch on the design
   basis.** Same as P22.6 / P22.7 — every P-ticket
   design lock starts with a real-URL fetch and a
   4-framework comparison.
2. **Sub-ticket count = 12.** Two of the audit fixes
   (P23.11 amend `bug.md` for #17 and #88) are doc-only
   and live in the same P. The other ten are code +
   test + changeset, the standard P22 shape.
3. **Pre-req ordering.** P23.1 must ship before P23.0
   (it provides `executeLoop`). P23.0 and P23.2 can
   then ship in either order. The independent fixes
   (P23.3-10) can be batched with P23.0/1/2 since they
   don't touch the same files.
4. **One commit per sub-ticket.** Matching the P22.6
   pattern (4 sub-tickets, 4 commits + design lock +
   TASKS row).
5. **Minor bumps** on `@lumen/core`, `@lumen/memory`,
   `@lumen/skills`, `@lumen/tools`, `@lumen/mcp`,
   `@lumen/llm`. Most sub-tickets touch only one
   package; the `executeLoop` refactor (P23.1) is the
   only sub-ticket that touches multiple.
6. **No new top-level package.** P23 uses the existing
   `packages/core` and `packages/memory` for the new
   tests. CLAUDE.md rule #9 stands.
7. **bug.md → bug-fixed.md rename.** The amended
   audit-hygiene file lands as `bug-fixed.md` so the
   P22 audit record is preserved alongside the P23
   verdict. The two filenames make it explicit which
   is the working copy and which is the canonical
   record.
8. **FEATURE_GAP items (19) deferred.** P24+ scope.
   The P23 sweep is the bug-fix sweep, not the
   feature-impl sweep. The 8 PARTIAL items are
   documented as PARTIAL in `bug-fixed.md` with
   the rationale for not fixing them now.
9. **No push to `origin/main`.** Per the
   lumen-contributing skill, the user is the only one
   who pushes. P23 lands locally and waits for the
   user to `git push --no-verify` (or not).
10. **TASKS row added** in P23.12, matching the P22.6
    shape (one row per sub-ticket, commit hash in
    parens).