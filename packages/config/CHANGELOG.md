# @lumen/config

## 0.16.0

### Minor Changes

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
