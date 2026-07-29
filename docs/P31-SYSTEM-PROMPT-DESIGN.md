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
 * | 1 | system prompt layering | single 4-line string | 7 sections + 1 dynamic, explicit cache boundary |
 * | 2 | cache_control wired up | primitive exists in `anthropic.ts`, dormant | marker-aware splitter in `buildRequestBody` main path |
 * | 3 | project context (CLAUDE.md / AGENTS.md) | not loaded | walk-up to git root + case-insensitive candidate priority |
 * | 4 | skill descriptions in system | `SkillTriggerMiddleware` P20.6 injects into system prompt — partial | folded into L4 skills section |
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
 * ### 1.2 7 sections + 1 dynamic
 *
 * | # | Section | Cache zone | Source |
 * | --- | --- | --- | --- |
 * | L1 | project | stable | `<cwd>/AGENTS.md` or `<cwd>/CLAUDE.md` (case-insensitive, walk up to git root) |
 * | L2 | identity | stable | `AgentConfig.systemPrompt` override + built-in default + optional `~/.lumen/SOUL.md` |
 * | L3 | tools | stable | `ToolRegistry` render of tool name + description + brief schema summary |
 * | L4 | skills | stable | `SkillRegistry` render of currently active skills (P20.6 `SkillTriggerMiddleware`) |
 * | L5 | memory | stable | `BaseMemoryStore` snapshot summary + relevant recall (P26.2 people-aware) |
 * | L6 | runtime | stable | cwd, git status snapshot, sandbox info, model + provider name (frozen at first turn) |
 * | **D1** | **dynamic** | **dynamic** | session_id, current time, ephemeral hints (per-turn, not cached) |
 *
 * Section order is fixed (OpenClaw
 * `CONTEXT_FILE_ORDER` map at `system-prompt.ts:74-87` is
 * the reference; lumen uses the same priority but folds
 * SOUL.md into L2 rather than splitting it).
 *
 * ### 1.3 cache boundary placement
 *
 * - Stable sections L1–L6 join with `\n\n`.
 * - L6 (runtime) is the LAST stable section; the boundary
 *   marker follows.
 * - D1 (dynamic) appends after the marker, joined with
 *   `\n\n` if multiple dynamic fragments exist.
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
 * | `packages/core/src/agent/system-prompt-sections.ts` | 7 section builders + `buildSystemPrompt(ctx)` aggregator | NEW (P31.2) |
 * | `packages/core/src/agent/system-prompt-project.ts` | `loadProjectContextFile(cwd)` walk-up + case-insensitive candidate priority | NEW (P31.3) |
 * | `packages/core/src/agent/system-prompt-cache.ts` | `cacheStablePromptPrefix` LRU + `hashStablePromptInput` SHA-256 | NEW (P31.4) |
 * | `packages/llm/src/anthropic.ts` | `buildAnthropicSystemBlocksFromString` marker-aware splitter; existing `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)` retained as escape hatch | MODIFIED (P31.5) |
 * | `packages/core/src/agent/index.ts` | `Agent` gains `cachedSystemPrompt: string \| undefined` + `buildAndCacheSystemPrompt(ctx)` method | MODIFIED (P31.6) |
 * | `apps/cli/src/composition.ts` | `buildAgent` constructs `SectionContext` + invokes `buildSystemPrompt`; `--no-cache-boundary` flag for degradation | MODIFIED (P31.6) |
 * | `apps/cli/src/commands/init.ts` | `--with-claude-md` flag writes `<cwd>/CLAUDE.md` template | MODIFIED (P31.7) |
 * | `packages/core/test/system-prompt-boundary.test.ts` | 8 tests aligning with OpenClaw `system-prompt-cache-boundary.test.ts` | NEW (P31.1) |
 * | `packages/core/test/system-prompt-sections.test.ts` | 7 section builders × 3-5 tests each | NEW (P31.2) |
 * | `packages/core/test/system-prompt-project.test.ts` | 5 tests (case-insensitive / walk-up / truncation) | NEW (P31.3) |
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
 * | **P31.3** | `feat(core): AGENTS.md / CLAUDE.md project context loader` | `system-prompt-project.ts` + test | +100 / +120 | 同上 + real cwd |
 * | **P31.4** | `feat(core): LRU stable prefix cache + SHA-256 input hash` | `system-prompt-cache.ts` + test | +50 / +80 | 同上 |
 * | **P31.5** | `feat(llm): Anthropic provider marker-aware system block splitter` | `anthropic.ts` modify + test | +80 / +150 | `pnpm --filter @lumen/llm test` |
 * | **P31.6** | `feat(core): Agent.run system prompt cache + composition wiring` | `index.ts` + `composition.ts` + test | +150 / +200 | `pnpm --filter @lumen/cli test`; real `lumen run`; verify byte-stable across 2 runs |
 * | **P31.7** | `feat(cli): lumen init --with-claude-md writes project prompt template` | `init.ts` + `index.ts` + test | +50 / +80 | cli test + real init |
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
 *   identity-section override. Existing fixtures pass.
 * - `providerOptions.anthropicSystemBlocks` (anthropic.ts:303)
 *   unchanged in type; power-user escape hatch.
 * - `DEFAULT_SYSTEM_PROMPT` constant (index.ts:208) becomes
 *   the L2 identity fallback when `systemPrompt` is not
 *   set AND `~/.lumen/SOUL.md` is absent.
 * - `--no-cache-boundary` CLI flag opts out of marker
 *   injection (the system prompt becomes one string into
 *   the provider with `cache_control` if supported, no
 *   boundary split). Useful for providers that mishandle
 *   the marker literal.
 *
 * ## 7. Open questions for review
 *
 * 1. **Should `--no-cache-boundary` exist?** Risk: every
 *    flag is a maintenance burden. Benefit: edge-case
 *    providers (custom OpenAI-compatible that renders the
 *    marker verbatim). Default: ship the flag, leave
 *    off-by-default.
 * 2. **Should `~/.lumen/SOUL.md` exist at all?** Hermes
 *    has it; OpenClaw doesn't (uses `soul.md` in
 *    workspace). lumen is between — `SOUL.md` in
 *    `~/.lumen/` is per-user, not per-project. Decision:
 *    ship `SOUL.md` support in P31.6 as identity override;
 *    defer workspace `soul.md` to P31+ follow-up.
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
