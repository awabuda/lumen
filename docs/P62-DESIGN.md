/**
 * P62 — MEMORY.md / USER.md auto-inject into system prompt
 *
 * ## 0. Why
 *
 * Lumen has a working `records` table (`@lumen/memory` SqliteStore) with
 * FTS5 + sqlite-vec + trust scores, plus the `lumen memory list/show/sync/prune`
 * CLI surface that round-trips records ↔ `~/.lumen/MEMORY.md` / `USER.md`.
 * But the agent does NOT auto-inject those markdown files into the system
 * prompt — a user that opens `~/.lumen/MEMORY.md` and adds "用户偏好:中文简洁
 * 回答" sees the line on disk but the model never reads it. The records
 * exist (P5.x + P10.x), the markdown exists (P19.5 + P32.x), the bridge exists
 * (`lumen memory sync`); the missing piece is the **read** step on the
 * system-prompt path.
 *
 * This is exactly the gap Hermes / OpenClaw / LangGraph / Claude Code all
 * close (see `docs/p62-evidence.md` for the 4-framework compare).
 *
 * ## 1. Design
 *
 * ### 1.1 Frozen snapshot invariant (P62 = snapshot 注入, not live read)
 *
 * The system-prompt prefix is **byte-stable for the entire session**
 * (P31.1 cache boundary + P31.6 dynamic suffix). If we re-read MEMORY.md
 * on every agent turn, the prefix mutates → cache invalidates → user's
 * per-conversation cost multiplies.
 *
 * The fix: read MEMORY.md + USER.md **once at session start** into a
 * frozen snapshot object. Inject the rendered block into the dynamic
 * suffix (`appendDynamicChunk`) on the FIRST model call only. Mid-session
 * edits to MEMORY.md do NOT propagate until the next session — matching
 * Hermes `MemoryStore._system_prompt_snapshot` semantics
 * (`tools/memory_tool.py:178-211`) and OpenClaw's
 * `cacheStablePromptPrefix` (`src/agents/system-prompt.ts:1050-1053`).
 *
 * ### 1.2 Threat pattern scan on load (Hermes-aligned)
 *
 * Hermes `_sanitize_entries_for_snapshot` (line 188) scans every entry
 * with `tools/threat_patterns.py` "strict" scope at load time. A hit
 * replaces the entry in the snapshot with `[BLOCKED: <file> entry
 * contained threat pattern: <ids>]` — the original stays in live state
 * so the user can SEE poisoned entries via the source files (silently
 * dropping them would hide the attack from the user).
 *
 * P62 follows the same shape: `loadMemorySnapshot()` returns
 * `{ memory: sanitizedBlock, user: sanitizedBlock }`. Scan is
 * deterministic from disk bytes (no LLM involvement), so the snapshot
 * is stable for the entire session. We do NOT implement the full
 * threat-pattern library yet (P63 follow-up) — P62 ships a 4-pattern
 * minimal set:
 *   - `system_override` (e.g. `ignore previous instructions`)
 *   - `prompt_leak` (e.g. `reveal your system prompt`)
 *   - `tool_inject` (e.g. `curl ... | sh`)
 *   - `secret_exfil` (e.g. `cat ~/.ssh/id_rsa`)
 *
 * Matched entries become `[BLOCKED: <file> entry contained pattern: <id>]`.
 * The original entry stays in the markdown file unchanged so the user
 * can see + remove it via their editor.
 *
 * ### 1.3 Middleware shape (P19+ invariant)
 *
 * "Inject content into the system prompt on every model call" is **an
 * Agent loop extension** → AgentMiddleware (P19+ rule 11). The wire-up:
 *
 * ```ts
 * const agent = new Agent({
 *   ...,
 *   middleware: [
 *     ...existing,
 *     createMemoryInjectMiddleware({ snapshot, enabled: true }),
 *   ],
 * })
 * ```
 *
 * The middleware reads the frozen `snapshot` from the closure and
 * pushes the rendered block into `ctx.appendDynamicChunk` on the
 * first `applyBeforeModel` call. The snapshot is captured by closure,
 * not by `AgentConfig` (P19+ rule 11 forbids `enableMemory` boolean
 * on AgentConfig).
 *
 * ### 1.4 Tier isolation
 *
 * P62 lives in **`@lumen/core`** (the new middleware function) +
 * **`apps/cli`** (composition root wire + flag). It does NOT add a new
 * package and does NOT change `BaseMemoryStore` (no
 * cross-tier import: core → memory is forbidden per
 * `docs/ARCHITECTURE.md` tier diagram). The markdown files are read
 * from the filesystem by the composition root (`apps/cli`) and passed
 * to the middleware as a serialised `MemorySnapshot` object — core
 * stays storage-agnostic.
 *
 * ### 1.5 P31 R3 compliance
 *
 * The memory block is rendered as ONE chunk that lands in the
 * **dynamic suffix** of the system prompt (post-cache-boundary
 * marker). It does NOT introduce a standalone `{ role: 'system' }`
 * message, which would force providers that re-segment the message
 * list (Anthropic `system` blocks) to invalidate the cache. The
 * middleware uses `ctx.appendDynamicChunk` (the sanctioned surface
 * per `packages/core/src/agent/middleware.ts:181`) which routes
 * through `appendDynamic` in
 * `packages/core/src/agent/system-prompt-boundary.ts`.
 *
 * ### 1.6 Opt-out flag
 *
 * `--no-memory-inject` (CLI) and `LUMEN_NO_MEMORY_INJECT=1` (env):
 * skip the wire-up. Defaults to **on** for `lumen chat`, **off** for
 * `lumen run --no-memory` (the latter already means "no memory store"
 * so memory-inject is moot). The flag is checked at composition
 * time, not at runtime — no per-call overhead.
 *
 * ## 2. Slice
 *
 * 1 commit (`feat(core+cli): P62 — MEMORY/USER auto-inject into system
 * prompt`) covering:
 *   - `packages/core/src/agent/middleware/memory-inject.ts` — middleware
 *     function `createMemoryInjectMiddleware({ snapshot })` with
 *     appendDynamicChunk on first call
 *   - `packages/core/src/agent/middleware.ts` — register the middleware
 *     type in the middleware union
 *   - `packages/core/src/agent/middleware/memory-inject.test.ts` —
 *     4 unit tests: snapshot render, threat scan block, opt-out
 *     flag respected, frozen-after-first-call
 *   - `apps/cli/src/composition.ts` — wire `--no-memory-inject` flag
 *     and `loadMemorySnapshot()` call
 *   - `apps/cli/src/index.ts` — add `--no-memory-inject` to the
 *     `lumen chat` and `lumen run` flag list
 *   - `apps/cli/test/p62-batch.test.ts` — 2 integration tests:
 *     MEMORY.md content enters chat system prompt; blocked entry
 *     becomes `[BLOCKED:]` not the raw content
 *
 * ## 3. Out of scope (deferred P-tickets)
 *
 * - **P63** — reflection middleware auto-promote user fact to records
 *   + MEMORY.md (the WRITE side; P62 is the READ side)
 * - **P64** — `lumen memory put` / `lumen memory get` subcommand for
 *   manual fact management
 * - **P65** — threat pattern library expansion (P62 ships 4 patterns;
 *   full Hermes parity needs ~20 patterns)
 * - **P66** — cross-cwd MEMORY scoping (per-project override)
 * - **OpenClaw-equivalent REM dreaming** — out of scope; 1-2 commit
 *   budget cannot fit a QMD-like vector index + replay-safe
 *   compaction. Documented as future work.
 *
 * ## 4. Evidence
 *
 * - `docs/p62-evidence.md` — 4-framework comparison with fetched
 *   source URLs (LangGraph Store + Claude Code auto-memory + Hermes
 *   snapshot + OpenClaw memory-host-core)
 * - `docs/OPTIMIZATION-PLAN.md` §B.1 — pre-existing design sketch
 *   that P62 implements
 * - `packages/core/src/agent/middleware/plan.ts:152-167` — reference
 *   implementation of `appendDynamicChunk` usage
 * - `~/.hermes/hermes-agent/tools/memory_tool.py:178-211` — Hermes
 *   reference for frozen snapshot + threat scan
 * - `~/workspace/openclaw-main/src/plugin-sdk/memory-host-core.ts:464-470` —
 *   OpenClaw MEMORY.md canonical detection
 */
