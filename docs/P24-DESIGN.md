# P24 design lock — bug.md FEATURE_GAP first sweep (browser + parallel MCP init)

> **Design-only pass.** P24 closes the first batch of bug.md
> FEATURE_GAP items that fit the existing core/tool architecture
> without dragging in a new tier. Three scope items land in P24.0
> — P24.3: **browser automation (#9)**, **parallel MCP init
> (#48)**, **fail-closed MCP (#47)** — and **Computer Use
> (#10)** ships as a deferred component (P24.4) because it
> requires a desktop-control native dependency that violates
> the `better-sqlite3`-only-native-dep guardrail (P22.7).
> The remaining FEATURE_GAP items (#37, #38, #39, #40, #43,
> #44, #49, #50, #51, #53, #54) defer to P25+ since each
> requires its own design lock.

## 0. Why P24

### 0.1 Source

`bug.md` audit (2026-07-15, sweep on 2026-07-22) closed 53/55
items (60/73 by count). The remaining 13 items are FEATURE_GAP
— design-bounded new capabilities without a lumen-in-repo
fix shape yet. P24 takes the **first three** because they share
a common theme (replace manual/synchronous plumbing) and ship
in a single batch:
  - **#9  browser automation** — single biggest gap; the only
    working browser surface today is `WebFetchTool` (HTTP
    fetch), which fails on SPAs, login-walled sites, JS-driven
    pagination, and form-requester pages.
  - **#48 parallel MCP init** — `McpRegistry.loadAll` is serial;
    every additional server adds cold-start latency. Trivial
    fix (`Promise.all`) but the design must lock the failure
    mode (one bad server must not abort the others).
  - **#47 fail-closed MCP** — security-class gap; today the MCP
    registry accepts any server from the config and grants
    every tool its full Python access. A misconfigured
    `mcpServers` entry is a security incident.

### 0.2 4-framework fetch verification (2026-07-22)

| Framework | URL fetched today | Key takeaway for P24 |
| --- | --- | --- |
| **Claude Code (Anthropic News)** | `https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously` | The release post names "Subagents, hooks, and background tasks" as the 2025-Q3 surface. **Computer Use is a *separate* Anthropic feature** (per the deprecated "computer use" beta doc) that requires Chrome-devtools-protocol-equivalent screen / keyboard / mouse control. The release post does not include browser automation in the announced capability set — Claude Code continues to expose the operator's existing terminal / file / search suite, not a built-in browser. **Lumen's #9 (browser automation) and #10 (Computer Use) are both genuine FEATURE_GAPs.** |
| **Playwright 1.x** | `https://playwright.dev/docs/intro` | The intro page exposes `browser` (default: yes, headless Chromium), `browser-contexts`, and a tagged-union API (`apiRequest`, `route.fulfill`, `page.goto`, `locator.click`, etc.). The library is **TypeScript-native**, ships ESM types, and is the de-facto browser-control library for Claude Code / OpenClaw style agent harnesses. **The lumen fix builds on `@playwright/test`-shaped APIs (NOT the test runner — just the API).** |
| **LangGraph 1.0 sub-agents** | (no new fetch — reuse P23 §0.3) | Sub-agents are first-class graph nodes; sub-graph state is a strict subset of the parent. **Browser automation is a *tool*, not a sub-agent feature** — the plan keeps the Playwright-backed browser in the *tool registry*, not under `SubAgentMiddleware`. |
| **OpenClaw** | `https://openclaw.ai/blog` (re-fetched 2026-07-15, also used in P23) | OpenClaw ships "Safer Than YOLO" auto-mode + VirusTotal integration but **does not document a `web_browser` tool**. Their blog paths are client-side Next.js (zero `<h1>` in fetched HTML, server-side stripped) so the body of any single post is unreachable from sandbox; the conclusion is by-process-of-elimination: OpenClaw likely either ships one behind the scenes and does not publish, or does not ship one. **No precedent to mirror**; the lumen implementation lands from Playwright's API surface + the lumen's `BaseTool` contract. |

**Synthesis**: only Playwright is a direct precedent for browser
automation in 2026-H2 agent frameworks. Claude Code does not
ship a built-in browser tool, and OpenClaw's docs are unfetchable
on the surface (Next.js hydration shell). The P24.0 plan lands a
lumen-native `web_browser` tool backed by Playwright + the lumen
`BaseTool` contract (P19.0). MCP #48 and MCP #47 land alongside
because they share the same `McpRegistry` plumbing — shipping
them in P24.0 avoids a re-touch.

### 0.3 6-question audit (post-P23.12)

| # | Question | Lumen status (post-P23.12) | P24.0 gap |
| --- | --- | --- | --- |
| 1 | Skill | full (P20.6) | full |
| 2 | Team | full (P19.3/4 + P20.7) | full |
| 3 | Workspace | full (P20.4 + P21.2) | full |
| 4 | Context | full (P6/P9) | full |
| 5 | Failure | full (P21.0/P21.1) | full |
| 6 | Security + Risk | full (P22.0 + P22.5) | full |
| 7 | Composition | full (P22.6) | full |
| 8 | **External capability (browser + MCP)** | absent | **closes with P24.0** |
| 9 | **MCP fail-closed posture** | absent | **closes with P24.0 (#47)** |
| 10 | **MCP startup parallelism** | single-flight | **closes with P24.0 (#48)** |

Two new axes (8 + 9 + 10) close via P24.0. The other 11
FEATURE_GAP items do **not** introduce a new audit axis — they
extend the existing axes by depth, not by dimension. They
remain P25+ candidates.

## 1. Architecture decisions (locked in this pass)

### 1.1 Browser automation (#9) — `web_browser` tool

- **Scope**: a single `web_browser` tool (`@lumen/tools`,
  new file `src/web/browser/index.ts`) that wraps Playwright's
  *API* (NOT its test runner). The tool exposes the four
  primitives the agent actually needs:
  - `goto(url)` — navigate, wait for `load`, return
    `{ url, title, status, screenshot? }`.
  - `act(selector, action)` — `click` / `dblclick` / `fill` /
    `press` / `hover` / `select` / `check` / `uncheck` /
    `scrollIntoViewIfNeeded` etc.
  - `extract(selector, schema?)` — read DOM elements
    (innerText / attributes / multiple) and optionally parse
    into a Zod schema the caller passes in. Like
    `WebFetchTool`, it must return *typed* data so the agent
    can reason without re-parsing.
  - `screenshot(selector?, fullPage?)` — return `data:image/png`
    base64. The CLI surface also exposes this through `lumen
    run --screenshot <path>` (P24.1 follow-up).

- **Why a single tool, not a tool-set**: lumen's `BaseTool`
  exposes a typed `name` + `risk`; a single composite tool
  keeps the permission story in one place (operators can
  allow `web_browser.act` only, deny `web_browser.goto`).
  The `op` field is the discriminator (same pattern as
  `GitTool` / `WebFetchTool` / `WebSearchTool`).

- **Why not Computer Use (#10) here**: Computer Use needs
  screen / keyboard / mouse at the OS level. The only mature
  implementations are Selenium-derivative or `nut.js`, both
  of which add a native dep (X11 / Quartz / accessibility
  APIs). **Lumen's native-dep guardrail (P22.7 §3) forbids
  anything beyond `better-sqlite3`.** P24.0 ships #9 only.
  #10 (Computer Use) is named explicitly as P24.4 in §3.

- **Lifecycle**: Playwright launches a browser per `web_browser`
  tool instance. Lumen composition root caches the browser in
  the closure of the active conversation turn; a separate
  conversation turn starts a fresh browser instance. This
  mirrors the `Redis` / `SqliteStore` instance lifecycle in
  `buildAgent` (P22.2) — never free pool-wide.

- **Sandboxing**: the default policy file (`permissionsPath`,
  P22.2) does NOT auto-grant `web_browser`. Operators opt in
  via `tools: [web_browser]` in their YAML policy file. Sites
  the agent should not visit are not enforceable at the network
  layer from lumen; we expose `allowedDomains?: string[]` as
  a hook into Playwright's request-blocking layer so operators
  can lock to e.g. `[*.example.com]`.

- **Risk**: `web_browser` defaults to `approval-required`
  (mirroring `git commit`). Operators who want zero-prompt
  automation pass `--approve-on web_browser` at session start.

### 1.2 MCP parallel init (#48)

- **Where**: `McpRegistry.loadAll` → `Promise.all` over the
  per-server connect attempts. The current implementation in
  `packages/mcp/src/registry.ts` already iterates one-at-a-time.

- **Failure semantics**: per-server `catch`; one failed
  server prints a structured warning to stderr (matches the
  existing `try` block in `buildAgent`'s MCP block) and the
  registry continues with the rest. `await Promise.all` with
  per-promise `try/catch` is the explicit shape — we are NOT
  using `Promise.allSettled` because we want fast-fail on
  *unrecoverable* transport errors (e.g. spawn ENOENT), which
  `try` catches and converts to a warning anyway. If we hit
  latency regression we revisit (`allSettled` is the swap).

- **Timeout**: per-server `connectAllMcpServers` already
  accepts a `timeoutMs`. P24.0 keeps the existing default
  (`5_000`).

### 1.3 MCP fail-closed (#47)

- **Where**: `McpRegistry.loadAll` rejects servers that are
  not on the operator's explicit allow-list. The mechanism:
  a new `mcp.security` block in `lumen.config.ts`:

  ```ts
  mcp: {
    servers: [...],
    security: {
      failClosed: true,            // default true; opt-out for legacy
      allowServerIds: ['github', 'slack'],   // optional further lock
    },
  }
  ```

  `failClosed: false` is a one-time escape hatch for operators
  who already vetted their config; the changelog warns it is
  "off by default" because the default is fail-closed.

- **Why a config flag, not hard-coded**: there are legitimate
  internal-network MCPs that operators want to allow without
  hand-typing an allow-list; the flag preserves that path
  without re-introducing the security hole.

- **Default**: `true` (fail-closed). Pre-P24 the registry
  accepted every server in `config.mcp.servers` without
  checking; P24.0 flips the default so operators have to opt
  *out*, not opt *in*.

## 2. P24.0 commit shape (P19+ rule #11 — commit-by-commit)

| commit | shape | summary |
| --- | --- | --- |
| `docs: P24.0 design lock — browser + parallel MCP + fail-closed` (this commit) | design-only | `docs/P24-DESIGN.md` (this file) + `TASKS.md` P24 row. |
| `feat(tools): P24.1 web_browser tool — Playwright-backed goto/act/extract/screenshot` | tool + tests | new `@lumen/tools/src/web/browser/index.ts` + `PlaywrightBrowserProvider` + `WebBrowserTool` + 5-case e2e (login-walled site / SPA / form submit / extract schema). |
| `feat(mcp): P24.2 McpRegistry.loadAll runs in parallel` | refactor + tests | `packages/mcp/src/registry.ts` swaps the serial loop for `Promise.all`. Test: 3 servers with varying connect delays complete in `~max(delays)` not `~sum(delays)`. |
| `feat(mcp+security): P24.3 fail-closed MCP registry` | config + tests | `McpRegistryOptions.failClosed` (default true) + per-server allow-list. Test: a server not on the allow-list is rejected with a structured error. |
| `feat(cli): P24.4 web_browser plugin + lumen run --screenshot + tests` | CLI + e2e | `lumen run` with `--web-browser` flag + `--screenshot <path>` write. |
| `docs: P24.0 backfill TASKS.md + bug.md` | docs | adds commit rows + fixes bug.md status banner. |

`#10 Computer Use` stays explicitly deferred. The TASKS
row lists it as P24.4 (FOOTNOTE only — *not* planned for
the current P24.0 sweep).

## 3. Footnotes (explicit deferrals)

- **#10 Computer Use** — P24.4 (NOT a P24.0 commit). Rationale:
  requires a native dep beyond `better-sqlite3`. Lumen's
  policy is documented in `P22.7-DESIGN.md` §3. Operators
  who need Computer Use today should use the `web_browser`
  tool's `act(selector)` primitive (which can drive Chromium
  the same way Computer Use does, modulo pixel-coordinate
  vs. semantic-selector input).
- **#48 parallel MCP init** — bundles with P24.0 because the
  refactor touches the same file (`registry.ts`) as #47.
- **#47 MCP fail-closed** — bundled with P24.0 because it
  ships next to the registry that needs it.
- **#37 / #38 / #39 / #40 / #43 / #44 / #49 / #50 / #51 / #53 /
  #54** — P25+ each; these need their own design locks and
  their own 4-framework fetches.
