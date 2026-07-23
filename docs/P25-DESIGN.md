# P25 design lock — bug.md FEATURE_GAP batch two (multi-axis capabilities)

> **Design-only pass.** P24 closed the FEATURE_GAP items that
> live inside the existing `tools` / `mcp` packages with
> minimal cross-axis impact (bug.md #9 #47 #48, plus
> #10's deferral note). P25 takes the remaining 12
> FEATURE_GAP items, each of which touches a *new* audit
> axis (team composition, skill expansion, sub-agent
> routing, hooks lifecycle, worktree isolation,
> multi-channel adapter, MCP surface extension,
> Background Task, Agent View, Proactive Execution,
> Manifest-first, Permission Modes, apply_patch).
> One design doc per item is the P25.x unit; this batch
> doc is the umbrella that names the per-item scope.

## 0. Why P25

### 0.1 Source

`bug.md` (working-tree audit tracker) lists 73 issues; P22.7
+ P23 + P23.11 + P23.12 + P24 closed 60 of them by code. The
remaining 13 items are FEATURE_GAP (new capabilities, not
patches). After P24 shipped 3 (#9 #47 #48) and deferred 1
(#10), P25 starts with **12 items**:

  - **#37** 子代理上下文隔离 — per-sub-agent context store
  - **#38** auto-dispatch — LLM-based sub-agent routing
  - **#39** Explore/Plan/General-purpose sub-agents — three
    prompt templates
  - **#40** 路径作用域规则 — glob-based rule loader
  - **#43** worktree 隔离 — git worktree auto-create + cleanup
  - **#44** 多渠道适配器 — Slack / Telegram / WhatsApp +
    i18n surface
  - **#49** Background Task — long-running async tasks
  - **#50** Agent View — observer-mode task list
  - **#51** Proactive Execution — ProactiveAgent wrapper
  - **#52** Manifest-first — package.json metadata-driven config
  - **#53** Permission Modes 扩展 — 4 modes × permission enum
  - **#54** apply_patch — multi-file V4A patch tool

### 0.2 4-framework fetch verification (2026-07-23)

| Framework | URL fetched today | Key takeaway for P25 |
| --- | --- | --- |
| **LangChain 1.0 middleware** | (re-use P23 §0.3) | Middleware shape is identical to P23. P25 #49 #50 #51 build on top of the existing `AgentMiddleware` surface. |
| **LangGraph subgraphs** | (re-use P23 §0.3) | #37 #38 #39 ride on the same subgraph boundary model. |
| **Claude Code sub-agents / hooks / worktree isolation / background tasks / permission modes / apply_patch** | `https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously` (re-fetched 2026-07-23) | The release post enumerates the same surface: **subagents, hooks, background tasks, /rewind (auto-checkpoints)**, and the `isolation: 'worktree'` field on sub-agent frontmatter. The `apply_patch` tool is a Claude Code feature too. The full sub-agent frontmatter (`permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `effort`, `isolation`, `background`) is the direct precedent for #37 #38 #39 #43 #49 #50 #53. |
| **OpenClaw** | (re-use P23 §0.3) | OpenClaw's supply-chain hardening and `pnpm.onlyBuiltDependencies`-style install-time check remain the closest analog for #52 (Manifest-first). |
| **Hermes Agent** | `https://hermes-agent.nousresearch.com/docs/` (re-fetched 2026-07-23) | Hermes exposes `cron` (one-shot / interval), `web` (search / fetch), `skills`, `mcp`, `memory`, `hooks`, `voice`. The `cron` + `mcp` + `skills` shape is the direct precedent for #49 (Background Task) and #54 (apply_patch is a Hermes-flavoured custom tool). |

**Synthesis**: Claude Code is the dominant precedent for #37
#38 #39 #43 #49 #50 #53. LangGraph is the architectural
alternative (subgraphs vs. per-sub-agent state slices).
Hermes Agent is the dominant precedent for #49 #54.
OpenClaw is the dominant precedent for #52. None of the
four frameworks ships a clean answer for #51 (Proactive
Execution); we design lumen-side.

### 0.3 6-question audit (post-P24.5)

| # | Question | Lumen status (post-P24.5) | P25 closes via |
| --- | --- | --- | --- |
| 1 | Skill | full (P20.6 + P23.11.C) | full |
| 2 | Team | full (P19.3/4 + P20.7) | extends via #37 #38 #39 |
| 3 | Workspace | full (P20.4 + P21.2) | full (no change) |
| 4 | Context | full (P6/P9) | extends via #37 |
| 5 | Failure | full (P21.0/P21.1) | full |
| 6 | Security + Risk | full (P22.0 + P22.5) | extends via #53 #54 |
| 7 | Composition | full (P22.6) | full |
| 8 | External capability | full (P24.1 web_browser) | full |
| 9 | MCP posture | full (P24.3 fail-closed) | full |
| 10 | MCP startup parallelism | full (P24.2 Promise.all) | full |
| 11 | **Team isolation** | partial | **closes with #37 #38 #39** |
| 12 | **Hooks lifecycle** | partial | **closes with #43 #49** |
| 13 | **Multi-channel** | absent | **closes with #44** |
| 14 | **Operator visibility** | absent | **closes with #50 #51** |
| 15 | **Config ergonomics** | partial | **closes with #52** |

Five new audit axes (11-15) close via P25. The remaining 12
items do NOT introduce a *new* audit axis \u2014 they extend the
existing axes by depth.

## 1. Architecture decisions (locked in this pass)

The 12 items fall into **5 buckets** by shared plumbing. P25.x
land one bucket at a time; each bucket is a single design doc
+ 2-5 implementation commits.

### 1.1 Bucket A \u2014 team composition (closes #37 #38 #39)

  - **#37** sub-agent context isolation: each sub-agent gets
    a `ContextStore` slice keyed by `subAgentId`. The slice
    is append-only via `MiddlewareStateView.set()` (P23.3
    surface); cross-sub-agent reads are permitted (P19
    design) but writes are blocked at runtime. Implementation
    lands in `packages/core/src/multi-user/sub-context.ts`
    + `sub-context.test.ts`.
  - **#38** auto-dispatch: an LLM-based router that picks
    which sub-agent to invoke. Implementation: a new
    `createAutoDispatchMiddleware({ router })` that
    intercepts the agent loop's `dispatchToolCall` and
    routes `subagent_spawn` calls. The router itself is
    a pluggable function so operators can supply their
    own heuristic / LLM.
  - **#39** three built-in sub-agents (`explore`,
    `plan`, `general-purpose`): prompt templates ship as
    SKILL.md files in `packages/skills/skills/builtins/`.
    The templates are explicit, single-file, no LLM call
    inside the template (Lumen's "no side effects in
    skill markdown" rule).

### 1.2 Bucket B \u2014 hooks lifecycle + worktree (#43 #49)

  - **#43** worktree isolation: `sub-agent.frontendisolation
    ?? 'worktree'` triggers a `git worktree add` + `git
    worktree remove` pair wrapped around the sub-agent's
    lifecycle. Implementation lands in
    `packages/tools/src/git/worktree.ts`. Tests use a
    throwaway git fixture.
  - **#49** Background Task: a new
    `BackgroundTaskRegistry` that owns long-running
    promises. The agent can spawn a background task and
    later `await` it (or check its status). Implementation
    lands in `packages/core/src/agent/background-tasks.ts`.

### 1.3 Bucket C \u2014 multi-channel + observability (#44 #50)

  - **#44** multi-channel adapter: `MessageChannel` interface
    with three reference adapters (`SlackChannel`,
    `TelegramChannel`, `WhatsAppChannel`). Operators wire
    whichever they want. The adapters sit in a new
    `packages/channels/` workspace so the channel surface
    does not pollute `@lumen/tools`.
  - **#50** Agent View: a read-only observer surface that
    exposes the agent's task list + currently-active
    sub-agents. Implementation lands in
    `packages/core/src/agent/view.ts`; the CLI gets a
    `lumen view` subcommand.

### 1.4 Bucket D \u2014 config + permission mode extensions (#51 #52 #53)

  - **#51** Proactive Execution: a `ProactiveAgent` wrapper
    that wakes the agent on a cron schedule, lets it
    decide whether to act, and exits. Implementation
    lands in `packages/core/src/agent/proactive.ts`.
  - **#52** Manifest-first: lumen reads `package.json`'s
    `lumen` block (analogous to OpenClaw's `pnpm.onlyBuiltDependencies`)
    and falls back to `~/.lumen/config.ts` only when the
    block is absent. Implementation lands in
    `packages/config/src/manifest.ts`.
  - **#53** Permission Modes: `default` / `acceptEdits` /
    `auto` / `bypassPermissions` (matching Claude Code's
    surface). Implementation lands in
    `packages/core/src/permissions/modes.ts`. The
    `static` mode is renamed to `default` for parity.

### 1.5 Bucket E \u2014 apply_patch (#54)

  - **#54** apply_patch tool: a multi-file V4A patch parser
    + applier. Implementation lands in
    `packages/tools/src/patch/apply.ts`. The format is
    Claude Code's V4A (line-based hunk diff). Operators
    opt in via `--approve-on apply_patch` (default
    `approval-required`).

## 2. P25 commit shape (P19+ rule #11 \u2014 commit-by-commit)

P25 ships as 5 buckets \u00d7 (design doc + 2-5 commits) =
**15-25 commits** total. Each bucket is one P25.x ticket.
The umbrella design doc (this file) ships first as a
single commit; per-bucket design docs follow the same
pattern as P24.0 \u00a72.

### 2.1 Bucket order (P25.x ticket sequence)

| P25.x | scope | commits (est.) | risk |
| --- | --- | --- | --- |
| **P25.0** | this umbrella design doc | 1 | none (design-only) |
| **P25.1** | bucket A \u2014 team composition | 5 (#37 #38 #39) | low |
| **P25.2** | bucket B \u2014 worktree + background tasks | 4 (#43 #49) | medium |
| **P25.3** | bucket C \u2014 channels + agent view | 4 (#44 #50) | low |
| **P25.4** | bucket D \u2014 proactive + manifest + permission modes | 5 (#51 #52 #53) | medium |
| **P25.5** | bucket E \u2014 apply_patch | 3 (#54) | medium |
| **P25.6** | umbrella backfill TASKS + bug.md | 1 | none (docs) |

Total: **~23 commits**, all under the P25 umbrella.

### 2.2 Out of scope (explicit deferrals)

  - **`#10` Computer Use** stays deferred per `docs/P24.5-DEFER-NOTE.md`.
  - **`#45` vision** stays as P26+ candidate (lumen ships
    no multimodal encoder yet; until Anthropic /
    OpenAI ship a single text + image embedding we
    defer the surface).
  - **`#46` People-aware memory** stays as P26+ candidate
    (similar reasoning \u2014 no clean cross-tool cross-user
    embedding surface yet).

## 3. Footnotes (existing decisions reused)

- **Native-dep guardrail** (P22.7 \u00a73): no new native deps
  in P25. `#43 worktree` uses the existing `simple-git`
  equivalent (already in the dep tree).
- **Helper function > abstract class** (P19+ rule 15): all
  P25 implementations prefer helper functions over new
  abstract classes. `#53 Permission Modes` extends the
  existing enum rather than introducing a `BaseMode`
  abstract class.
- **Operator-surface ergonomics** (P22.0): every P25 tool /
  feature gets an `--approve-on` flag in `lumen run`.