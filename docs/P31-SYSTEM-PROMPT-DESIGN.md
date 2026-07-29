/**
 * P31 design lock — system prompt layering + cache boundary
 *
 * > **Design-only pass.** P31 takes the system-prompt surface
 * > from a single 4-line string (`packages/core/src/agent/index.ts:208-211`)
 * > to a 7-section + 1-dynamic layered structure with explicit
 * > cache boundary markers, mirroring the OpenClaw main-branch
 * > design (`<!-- OPENCLAW_CACHE_BOUNDARY -->` in
 * > `packages/ai/src/utils/system-prompt-cache-boundary.ts:8`)
 * > while keeping Hermes's per-session byte-stable invariant
 * > (`agent/conversation_loop.py:996-1004`).
 *
 * ## 0. Why P31
 *
 * ### 0.1 Source
 *
 * The 2026-07-29 audit (§D test failures + §GAP-2 model
 * fallback) surfaced that the system prompt is a single
 * 4-line string with no layering and no cache-control
 * awareness. The Anthropic provider already ships the
 * structured-block primitive (`packages/llm/src/anthropic.ts:198-219`,
 * `AnthropicSystemBlock` + `cache_control: {type: 'ephemeral'}`),
 * plus `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)`
 * for power users (anthropic.ts:788-802), but the
 * `Agent.run` path (index.ts:505) just stuffs
 * `this.systemPrompt` into a single message —
 * `resolveSystemBlocks` is never reached from the
 * default caller path. The primitive is dormant.
 *
 * The 2026-07-29 audit also notes the user is both an
 * operator AND a developer: when they add a new feature
 * (P30+) and want to verify the agent loop's behavior, the
 * default `lumen run` system prompt is too thin to
 * demonstrate the new feature. P31 makes the system prompt
 * rich enough that the same `lumen run "<test prompt>"`
 * invocation exercises identity, tools, skills, project
 * context, and dynamic state — without each developer
 * having to remember a per-feature `--system-prompt` flag.
 *
 * ### 0.2 4-framework fetch verification (2026-07-29)
 *
 * | Framework | Source verified | Key takeaway for P31 |
 * | --- | --- | --- |
 * | **Hermes Agent** | `~/.hermes/hermes-agent/agent/conversation_loop.py:980-1004` + `agent_init.py:295-411,636-638,1325` + `chat_completion_helpers.py:1495-1505` | Per-session byte-stable `_cached_system_prompt` + `ephemeral_system_prompt` concatenated at API call time. NO explicit cache boundary marker; relies on Anthropic auto-cache on byte-stable prefix. Single string into API. |
 * | **OpenClaw** | `/Users/chengpengtao/workspace/openclaw-main/packages/ai/src/utils/system-prompt-cache-boundary.ts:8-65` + `src/agents/system-prompt.ts:74-87,145-168,1079-1297` + `packages/ai/src/providers/anthropic.ts:1548-1603` + `src/agents/sessions/resource-loader.ts:72-89` | Explicit `<!-- OPENCLAW_CACHE_BOUNDARY -->` marker split into stable prefix (cache_control tagged) + dynamic suffix (untagged). `buildAnthropicSystemBlocks` in the Anthropic provider does the split + cache_control injection. 4 providers (Anthropic / OpenAI / Mistral / Google) share the same systemPrompt string protocol. LRU 64 stable-prefix cache keyed by SHA-256 input hash. |
 * | **LangChain 1.0** | (re-use P23 §0.3 — LangChain does not ship a marker protocol; `SystemMessage` is a single string per request) | Confirms the marker-based split is a deliberately OpenClaw invention, not an industry pattern. lumen P31's choice to follow OpenClaw is opinionated. |
 * | **Claude Code** | (re-use P27 §0.2) | Ships `CLAUDE.md` as a project-level file but does not appear to use a cache boundary marker. Reinforces that the marker is OpenClaw-specific. |
 *
 * **Synthesis**: OpenClaw's marker protocol is the only
 * verified upstream design that exposes stable/dynamic
 * separation at the system-prompt layer (Hermes is implicit;
 * LangChain / Claude Code are monolithic). P31 ports the
 * marker to lumen under the `LUMEN_CACHE_BOUNDARY` prefix
 * (preserves lumen-namespacing rule, CLAUDE.md rule #1) and
 * lifts Hermes's per-session cache into a lumen-internal
 * `_cachedSystemPrompt` instance field.
 *
 * ### 0.3 6-question audit (post-P30.B2)
 *
 * | # | Question | Pre-P31 state | Post-P31 target |
 * | --- | --- | --- | --- |
 * | 1 | system prompt layering | single 4-line string | 8 stable sections + 1 dynamic (HEARTBEAT.md), explicit cache boundary |
 * | 2 | cache_control wired up | primitive exists in `anthropic.ts`, dormant | marker-aware splitter in `buildRequestBody` main path |
 * | 3 | context files (AGENTS / SOUL / USER / IDENTITY / TOOLS / BOOTSTRAP / MEMORY / HEARTBEAT) | not loaded | walk-up to git root + case-insensitive candidate priority; 7 stable + HEARTBEAT dynamic |
 * | 4 | tool registry rendering | `ToolRegistry` schemas go to `request.tools` only, not system prompt | L8 runtime block carries `ToolRegistry` schema dump + L5 TOOLS.md usage guidance (separate roles) |
 * | 4b | skill descriptions in system | `SkillTriggerMiddleware` P20.6 injects into system prompt — partial | L8 runtime block also carries active-skill index (next to `ToolRegistry` dump); full skill content still lazy via `skill_view` |
 * | 5 | session-level cache | none | `_cachedSystemPrompt` instance field + LRU 64 cross-session |
 * | 6 | per-turn dynamic content | merged into system prompt via `+ "\n\n" + ephemeral` (Hermes pattern) | split at marker, dynamic suffix bypasses cache_control |
 *
 * ## 1. Architecture decisions (locked in this pass)
 *
 * ### 1.1 Single string + cache boundary marker (OpenClaw pattern)
 *
 * - **Scope**: `packages/core/src/agent/system-prompt.ts`
 *   builds ONE string via 7 section builders + 1 dynamic
 *   section, joined by `\n\n` for stable and `<!--
 *   LUMEN_CACHE_BOUNDARY -->` between stable and dynamic.
 * - **Why not a typed `SystemLayer[]` to provider**: same
 *   reason OpenClaw doesn't — the Anthropic provider does
 *   the split in the wire-format layer, and OpenAI / Mistral
 *   / Google need a single string anyway. lumen keeps
 *   `providerOptions.anthropicSystemBlocks` as a power-user
 *   escape hatch (already in `anthropic.ts:788-802`).
 *
 * ### 1.2 8 sections + 1 dynamic (aligned with OpenClaw `CONTEXT_FILE_ORDER`)
 *
 * Per user direction (2026-07-29): keep the canonical
 * context-file names that already exist in the agent
 * ecosystem — `SOUL.md`, `USER.md`, `AGENTS.md`, `IDENTITY.md`,
 * `HEARTBEAT.md` — and add `TOOLS.md`, `BOOTSTRAP.md`,
 * `MEMORY.md` so the full OpenClaw 7-file priority order
 * is honoured. lumen P31 loads all 7 stable files from
 * `<cwd>/` (with `~/.lumen/` fallback for `SOUL.md` /
 * `IDENTITY.md` / `USER.md`), then HEARTBEAT.md is treated
 * as dynamic.
 *
 * | # | Section | Cache zone | Source |
 * | --- | --- | --- | --- |
 * | L1 | **project** (AGENTS.md) | stable | `<cwd>/AGENTS.md` or `<cwd>/CLAUDE.md` (case-insensitive, walk up to git root); matches OpenClaw `resource-loader.ts:72-89` |
 * | L2 | **soul** (SOUL.md) | stable | `<cwd>/SOUL.md` first, fallback `~/.lumen/SOUL.md`; persona/tone |
 * | L3 | **identity** (IDENTITY.md) | stable | `<cwd>/IDENTITY.md` first, fallback `~/.lumen/IDENTITY.md`; agent identity beyond the built-in default |
 * | L4 | **user** (USER.md) | stable | `<cwd>/USER.md` first, fallback `~/.lumen/USER.md`; user preferences / profile |
 * | L5 | **tools** (TOOLS.md) | stable | `<cwd>/TOOLS.md` first, fallback `~/.lumen/TOOLS.md`; tool-usage guidance (separate from `ToolRegistry` schema dump in L8) |
 * | L6 | **bootstrap** (BOOTSTRAP.md) | stable | `<cwd>/BOOTSTRAP.md` first, fallback `~/.lumen/BOOTSTRAP.md`; first-reply instructions ("follow before normal reply") |
 * | L7 | **memory** (MEMORY.md) | stable | `<cwd>/MEMORY.md` first, fallback `~/.lumen/MEMORY.md`; long-term memory snapshot (separate from in-session recall) |
 * | L8 | **runtime** | stable | cwd, git status snapshot, sandbox info, model + provider name, `ToolRegistry` schema dump (frozen at first turn) |
 * | **D1** | **heartbeat** (HEARTBEAT.md) | **dynamic** | `<cwd>/HEARTBEAT.md` first, fallback `~/.lumen/HEARTBEAT.md`; plus session_id, current time, ephemeral hints — by definition below the cache boundary |
 *
 * Section order matches OpenClaw `CONTEXT_FILE_ORDER`
 * (system-prompt.ts:74-87) with **L8 runtime = OpenClaw's
 * tools-metadata + bootstrap-info merged** (lumen's runtime
 * block carries cwd / git / sandbox / model — same role as
 * OpenClaw's "Bootstrap pending" lines at system-prompt.ts:340-353).
 * HEARTBEAT.md is mapped to OpenClaw's dynamic file
 * (`DYNAMIC_CONTEXT_FILE_BASENAMES = new Set(["heartbeat.md"])`,
 * system-prompt.ts:84).
 *
 * **Per-file lookup rule** (new in P31, not in OpenClaw):
 * for L2/L3/L4/L5/L6/L7 the lookup is
 * `<cwd>/<file>` first, fallback `~/.lumen/<file>`. The
 * fallback exists because some users keep personal persona /
 * identity / preferences in `~/.lumen/` (lumen HOME dir)
 * rather than per-project. Project-file lookup for L1
 * (AGENTS.md) uses walk-up to git root (no `~/.lumen/`
 * fallback — AGENTS.md is per-project by definition).
 *
 * **Cross-section dedup**: if a single `<cwd>/SOUL.md`
 * already encodes agent identity, the operator can choose
 * to leave L3 (`IDENTITY.md`) empty and the builder skips
 * the empty section (rather than emitting an empty
 * heading). OpenClaw's `buildProjectContextSection` does
 * the same skip for empty file arrays (system-prompt.ts:228-232).
 *
 * ### 1.3 cache boundary placement
 *
 * - Stable sections L1–L8 join with `\n\n`.
 * - L8 (runtime) is the LAST stable section; the boundary
 *   marker follows.
 * - D1 (HEARTBEAT.md + dynamic) appends after the marker,
 *   joined with `\n\n` if multiple dynamic fragments exist.
 * - When D1 is empty, `ensureSystemPromptCacheBoundary`
 *   still appends the marker so a future hook injection
 *   (`prependSystemPromptAdditionAfterCacheBoundary`)
 *   routes into the dynamic suffix, NOT into the stable
 *   prefix. This is the OpenClaw invariant
 *   (`system-prompt-cache-boundary.ts:19-24`).
 *
 * ### 1.4 Per-session `_cachedSystemPrompt` (Hermes pattern)
 *
 * - `Agent` instance owns `private cachedSystemPrompt?: string`.
 * - On first turn: `cachedSystemPrompt = await buildSystemPrompt(ctx)`.
 * - On subsequent turns: reuse `cachedSystemPrompt` if the
 *   `SectionContext` input hash matches the build hash;
 *   rebuild only when the input changes (tool registration
 *   delta, skill set delta, project file mtime, etc.).
 * - Persist across session resume? **No** — `_cachedSystemPrompt`
 *   is in-memory only. The persisted session DB stores the
 *   built string for diagnostic replay (P20.4), but
 *   resume rebuilds rather than restores verbatim (this
 *   differs from Hermes `_session_db.update_system_prompt`
 *   at `conversation_loop.py:423`; we choose rebuild
 *   because `SectionContext` includes runtime / skill / tool
 *   state that may have changed across restart).
 *
 * ### 1.5 Cross-session LRU stable-prefix cache (OpenClaw pattern)
 *
 * - 64-entry LRU keyed by SHA-256 of `JSON.stringify(ctxSummary)`.
 * - `ctxSummary` = the subset of `SectionContext` that
 *   affects the STABLE prefix only (cwd, tool list,
 *   skill list, project file path + mtime, model identity).
 * - Dynamic section is NEVER cached — it is recomputed
 *   every turn.
 * - 64-entry limit is the OpenClaw default
 *   (`SYSTEM_PROMPT_STABLE_PREFIX_CACHE_LIMIT = 64`,
 *   `system-prompt.ts:87`); we copy it.
 *
 * ## 2. File layout
 *
 * | Path | Purpose | Status |
 * | --- | --- | --- |
 * | `packages/core/src/agent/system-prompt-boundary.ts` | `SYSTEM_PROMPT_CACHE_BOUNDARY` constant + `split` / `strip` / `ensure` / `prepend` / `sanitizeSurrogates` | NEW (P31.1) |
 * | `packages/core/src/agent/system-prompt-sections.ts` | 8 section builders + `buildSystemPrompt(ctx)` aggregator | NEW (P31.2) |
 * | `packages/core/src/agent/system-prompt-context-files.ts` | `loadContextFiles(cwd, lumenHome)` walks `<cwd>` for the 8 OpenClaw context files; `~/.lumen/` fallback for personal-context files (SOUL / IDENTITY / USER / TOOLS / BOOTSTRAP / MEMORY) | NEW (P31.3a) |
 * | `packages/core/src/agent/system-prompt-project.ts` | `loadProjectContextFile(cwd)` walk-up to git root + case-insensitive AGENTS.md / CLAUDE.md candidate priority (sub-loader for L1) | NEW (P31.3b) |
 * | `packages/core/src/agent/system-prompt-cache.ts` | `cacheStablePromptPrefix` LRU + `hashStablePromptInput` SHA-256 | NEW (P31.4) |
 * | `packages/llm/src/anthropic.ts` | `buildAnthropicSystemBlocksFromString` marker-aware splitter; existing `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)` retained as escape hatch | MODIFIED (P31.5) |
 * | `packages/core/src/agent/index.ts` | `Agent` gains `cachedSystemPrompt: string \| undefined` + `buildAndCacheSystemPrompt(ctx)` method | MODIFIED (P31.6) |
 * | `apps/cli/src/composition.ts` | `buildAgent` constructs `SectionContext` + invokes `buildSystemPrompt`; `--no-cache-boundary` flag for degradation | MODIFIED (P31.6) |
 * | `apps/cli/src/commands/init.ts` | `--with-claude-md` flag writes `<cwd>/CLAUDE.md` template | MODIFIED (P31.7) |
 * | `packages/core/test/system-prompt-boundary.test.ts` | 8 tests aligning with OpenClaw `system-prompt-cache-boundary.test.ts` | NEW (P31.1) |
 * | `packages/core/test/system-prompt-sections.test.ts` | 8 section builders × 3-5 tests each | NEW (P31.2) |
 * | `packages/core/test/system-prompt-context-files.test.ts` | 6 tests (cwd-first / `~/.lumen/` fallback / HEARTBEAT-as-dynamic routing / truncation / empty-skip) | NEW (P31.3a) |
 * | `packages/core/test/system-prompt-project.test.ts` | 5 tests (case-insensitive / walk-up / git-root detection) | NEW (P31.3b) |
 * | `packages/core/test/system-prompt-cache.test.ts` | LRU eviction + hash determinism | NEW (P31.4) |
 * | `packages/llm/test/anthropic-marker.test.ts` | 4 tests (marker × cacheControl matrix) | NEW (P31.5) |
 *
 * ## 3. Commit breakdown
 *
 * | # | Commit | Files | LoC est. | Verification |
 * | --- | --- | --- | --- | --- |
 * | **P31.0** | `docs: P31 system prompt layering design lock` | `docs/P31-SYSTEM-PROMPT-DESIGN.md` (this file) | +260 | doc review |
 * | **P31.1** | `feat(core): system prompt cache boundary primitive` | `system-prompt-boundary.ts` + test | +150 / +150 | `pnpm --filter @lumen/core test` |
 * | **P31.2** | `feat(core): 7 section builders + aggregator` | `system-prompt-sections.ts` + test | +250 / +300 | 同上 |
 * | **P31.3** | `feat(core): 8 OpenClaw context-file loaders (cwd + `~/.lumen/` fallback)` | `system-prompt-context-files.ts` + test | +150 / +200 | 同上 + real cwd |
 * | **P31.4** | `feat(core): AGENTS.md / CLAUDE.md project context loader (sub-loader for L1)` | `system-prompt-project.ts` + test | +100 / +120 | 同上 + real cwd + real git repo |
 * | **P31.5** | `feat(core): LRU stable prefix cache + SHA-256 input hash` | `system-prompt-cache.ts` + test | +50 / +80 | 同上 |
 * | **P31.6** | `feat(llm): Anthropic provider marker-aware system block splitter` | `anthropic.ts` modify + test | +80 / +150 | `pnpm --filter @lumen/llm test` |
 * | **P31.7** | `feat(core): Agent.run system prompt cache + composition wiring` | `index.ts` + `composition.ts` + test | +150 / +200 | `pnpm --filter @lumen/cli test`; real `lumen run`; verify byte-stable across 2 runs |
 * | **P31.8** | `feat(cli): lumen init --with-claude-md writes project prompt template` | `init.ts` + `index.ts` + test | +50 / +80 | cli test + real init |
 *
 * **Total**: 8 commits, ~830 lines implementation + ~1080
 * lines tests + ~260 lines docs, estimated 4-6 sessions.
 *
 * ## 4. Risks + mitigations
 *
 * | Risk | Source | Mitigation |
 * | --- | --- | --- |
 * | P31.5 modifies Anthropic provider wire-up path; could break all Anthropic e2e tests | `anthropic.ts:740-780` `buildRequestBody` is hot path | Keep `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)` as escape hatch; add 4 unit tests for the marker × cacheControl matrix |
 * | P31.6 introduces new optional `systemPromptContext` field on `AgentConfig`; could break test fixtures | index.ts:71 has `systemPrompt?: string` already | Keep `systemPrompt?: string` as identity-section override; new field is optional |
 * | session-level cache pollutes cross-test state | `_cachedSystemPrompt` is instance attr | Test setup resets via `delete agent.cachedSystemPrompt` or unique model per test |
 * | byte-stable test fragility (string compare) | OpenClaw already had this footgun | Use SHA-256 hash of full stable prefix, not raw string compare |
 * | dynamic content leaks into stable prefix | OpenClaw has `ensureSystemPromptCacheBoundary` for exactly this | Always run `ensureSystemPromptCacheBoundary` in `buildSystemPrompt` |
 * | user adds `<cwd>/CLAUDE.md` with the marker literal inside the file | Boundary marker is `\n<!-- LUMEN_CACHE_BOUNDARY -->\n` | `sanitizeSurrogates` does NOT strip markers; rely on `ensureSystemPromptCacheBoundary` first-then-marker-pos check |
 *
 * ## 5. Comparison vs upstream (decision log)
 *
 * | Decision | Hermes | OpenClaw | **lumen P31** | Rationale |
 * | --- | --- | --- | --- | --- |
 * | system prompt form | single string | single string + marker | **single string + marker** | OpenClaw — explicit cache boundary, easier debugging |
 * | stable/dynamic split | string concat (no marker) | explicit marker | **explicit marker** | OpenClaw — `ensureSystemPromptCacheBoundary` defensive append |
 * | cache_control marker | implicit (byte-stable) | explicit | **explicit** | OpenClaw — debuggable + 4-provider test matrix exists |
 * | session-level cache | instance attr `_cachedSystem_prompt` | none | **instance attr** | Hermes — single-session benefit is real |
 * | cross-session LRU | none | LRU 64 + SHA-256 | **LRU 64 + SHA-256** | OpenClaw — cross-restart benefit when tools/skills stable |
 * | project file walk | (unverified, docs claim walk-up to git root) | single dir | **walk-up to git root** | Hermes docs claim — reasonable |
 * | project candidates | (unverified) | `["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` | **same** | OpenClaw — industry has converged |
 * | sanitize unicode | not in prompt path | `sanitizeSurrogates` on every block | **`sanitizeSurrogates`** | OpenClaw — unicode high-surrogate attack defense |
 * | multi-breakpoint cache | system + 3 sliding message breakpoints | system + tools + messages (dynamic budget) | **system only for v1** | KISS — measure gain before adding message breakpoints |
 * | ephemeral handling | `+ "\n\n" + ephemeral` (mutates stable prefix) | N/A (uses dynamic suffix) | **dynamic suffix via marker** | OpenClaw — never mutate stable prefix |
 *
 * ## 6. Compatibility notes
 *
 * - `AgentConfig.systemPrompt?: string` (index.ts:71)
 *   unchanged in type; semantically now becomes the
 *   identity-section override (folded into L3 IDENTITY.md
 *   priority chain). Existing fixtures pass.
 * - `providerOptions.anthropicSystemBlocks` (anthropic.ts:303)
 *   unchanged in type; power-user escape hatch.
 * - `DEFAULT_SYSTEM_PROMPT` constant (index.ts:208) becomes
 *   the L3 IDENTITY.md fallback when `systemPrompt` is not
 *   set AND neither `<cwd>/IDENTITY.md` nor
 *   `~/.lumen/IDENTITY.md` exists. Same role for L2 SOUL.md
 *   fallback when no SOUL.md is present.
 * - `--no-cache-boundary` CLI flag opts out of marker
 *   injection (the system prompt becomes one string into
 *   the provider with `cache_control` if supported, no
 *   boundary split). Useful for providers that mishandle
 *   the marker literal.
 * - L8 runtime block carries `ToolRegistry` schema dump
 *   + active-skill index. Existing P20.6 `SkillTriggerMiddleware`
 *   continues to inject; L8 just becomes the canonical
 *   home for it (no semantic change, just relocation).
 *
 * ## 7. Open questions for review
 *
 * 1. **Should `--no-cache-boundary` exist?** Risk: every
 *    flag is a maintenance burden. Benefit: edge-case
 *    providers (custom OpenAI-compatible that renders the
 *    marker verbatim). Default: ship the flag, leave
 *    off-by-default.
 * 2. **Per-user vs per-project separation — confirmed by user direction (2026-07-29)**: the 8 context files split into two groups:
 *    - **Per-project (L1 only)**: `AGENTS.md` / `CLAUDE.md`. Walk-up to git root, NO `~/.lumen/` fallback.
 *    - **Per-user (L2–L7 stable + D1)**: `SOUL.md` / `USER.md` / `IDENTITY.md` / `TOOLS.md` / `BOOTSTRAP.md` / `MEMORY.md` / `HEARTBEAT.md`. `<cwd>/` first, `~/.lumen/` fallback.
 *    Open question: should `~/.lumen/` fallback apply per-file (each file independently checks both locations) or all-or-nothing (either all from cwd or all from `~/.lumen/`)? Default: per-file, but flag for review after P31.3a lands.
 * 3. **Cache hit rate observability?** OpenClaw does not
 *    surface cache hit metrics. lumen could add a
 *    `cache_hits` counter to `Telemetry` (P8.3). Out of
 *    scope for P31 — revisit in P31.9 follow-up.
 * 4. **Multi-breakpoint message cache** (Hermes pattern):
 *    deferred to P31+. Profile first; if 80%+ cache hit
 *    on system alone, no need.
 *
 * ## 8. References (verified source)
 *
 * - `~/.hermes/hermes-agent/agent/conversation_loop.py:980-1004`
 *   (effective_system = active + "\n\n" + ephemeral)
 * - `~/.hermes/hermes-agent/agent/agent_init.py:295-411,636-638,1325`
 *   (ephemeral_system_prompt field, Anthropic auto-cache claim,
 *   `_cached_system_prompt` instance attr)
 * - `~/.hermes/hermes-agent/AGENTS.md:7-12` ("Per-conversation
 *   prompt caching is sacred")
 * - `/Users/chengpengtao/workspace/openclaw-main/packages/ai/src/utils/system-prompt-cache-boundary.ts:8-65`
 *   (SYSTEM_PROMPT_CACHE_BOUNDARY constant + split/strip/ensure/prepend)
 * - `/Users/chengpengtao/workspace/openclaw-main/packages/ai/src/providers/anthropic.ts:1548-1603`
 *   (buildAnthropicSystemBlocksFromString marker-aware splitter)
 * - `/Users/chengpengtao/workspace/openclaw-main/src/agents/system-prompt.ts:74-87`
 *   (CONTEXT_FILE_ORDER 7-file priority map)
 * - `/Users/chengpengtao/workspace/openclaw-main/src/agents/system-prompt.ts:145-168`
 *   (cacheStablePromptPrefix LRU + hashStablePromptInput SHA-256)
 * - `/Users/chengpengtao/workspace/openclaw-main/src/agents/sessions/resource-loader.ts:72-89`
 *   (AGENTS.md / CLAUDE.md case-insensitive candidate priority)
 * - `/Users/chengpengtao/workspace/lumen/packages/core/src/agent/index.ts:71,208-211,312,336,505`
 *   (current single-string system prompt surface)
 * - `/Users/chengpengtao/workspace/lumen/packages/llm/src/anthropic.ts:198-219,309-350,740-780,788-820`
 *   (existing AnthropicSystemBlock + resolveSystemBlocks + splitSystemAndMessages infrastructure)
 */
