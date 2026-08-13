---
"@lumen/cli": minor
"@lumen/core": minor
---

P62 — `~/.lumen/MEMORY.md` + `USER.md` are now
auto-injected into the agent's system prompt as a
frozen snapshot on every `lumen run` / `lumen chat` /
`lumen doctor` invocation. Pre-P62 the markdown files
existed (P34.1 `lumen memory sync` writes them) but
the agent never read them — a user that added "用户
偏好中文" to MEMORY.md saw the line on disk but the
model never saw it.

P62 closes the **read** side of the cross-session
memory loop. The **write** side (auto-promote
reflection-extracted facts to MEMORY.md) is deferred
to P63. See `docs/P62-DESIGN.md` for the full design
+ `docs/p62-evidence.md` for the 4-framework
comparison (Hermes `_system_prompt_snapshot` parity
+ OpenClaw `cacheStablePromptPrefix` parity +
LangGraph `Store` semantic search deferred to P66 +
Claude Code `MEMORY.md` 200-line / 25KB cap inspired
the snapshot-doesn't-grow-unboundedly contract).

The shape is identical to Hermes
`MemoryStore.load_from_disk` →
`_system_prompt_snapshot` → render block
(`~/.hermes/hermes-agent/tools/memory_tool.py:178-211`,
comment line 195-197 "stable for the entire session
(prefix-cache invariant holds)") and OpenClaw's
`buildMemorySection` + `cacheStablePromptPrefix`
(`src/agents/system-prompt.ts:1006-1075, 1185`).
Three properties that make the Lumen implementation
safe + cheap:

1. **Frozen snapshot** — `loadMemorySnapshot()` is
   called once at composition time; the
   `createMemoryInjectMiddleware` closes over the
   resulting object and pushes the rendered block
   into `ctx.appendDynamicChunk` only on the FIRST
   `beforeModel` call. Mid-session edits to
   MEMORY.md / USER.md do not propagate until the
   next session. Pinned by the 6th
   `p62-memory-inject.test.ts` case "does not push
   again even when a fresh context is passed in".

2. **Dynamic suffix, not standalone system message**
   — the chunk lands via the P31.6B-sanctioned
   `appendDynamicChunk` surface, which routes
   through `appendDynamic` in
   `system-prompt-boundary.ts`. This keeps the
   system prompt byte-stable for the entire
   conversation (prefix cache preserved) and
   prevents the Anthropic provider's
   `system` block re-segmentation from invalidating
   the cache.

3. **Threat pattern scan on load** — 4-pattern
   minimal set (system_override / prompt_leak /
   tool_inject / secret_exfil). A hit replaces the
   entry in the snapshot with
   `[BLOCKED: <file> entry contained pattern: <id>]`
   (Hermes `_sanitize_entries_for_snapshot` parity,
   `tools/memory_tool.py:185-244`). The original
   entry stays in the markdown file unchanged so
   the user can see + remove poisoned entries via
   their editor — silently dropping them would
   hide the attack from the user. The scan is
   deterministic from disk bytes; no LLM, no
   randomness. Full pattern-library expansion
   deferred to P65.

## CLI surface

- `--no-memory-inject` flag on `lumen chat` /
  `lumen run` (and the `LUMEN_NO_MEMORY_INJECT=1`
  env var): opt out of the wire-up. Default is ON
  (memory injection is the new default behaviour).
  The flag is a no-op when `--no-memory` is also
  passed (no memory store → no markdown file →
  nothing to inject).
- The `~/.lumen/MEMORY.md` + `USER.md` paths are
  overridable via `LUMEN_HOME` env (P22.x) so
  multi-profile / per-workspace overrides work
  without code changes.

## What is NOT in P62 (deferred)

- **P63** — reflection middleware auto-promote
  user fact to records + MEMORY.md (the WRITE
  side; P62 is the READ side)
- **P64** — `lumen memory put` / `lumen memory get`
  subcommand for manual fact management
- **P65** — full threat pattern library (P62
  ships 4 patterns; full Hermes parity needs ~20)
- **P66** — semantic search via the existing
  `BaseVectorMemoryStore` / `sqlite-vec` backend
  (LangGraph `Store.search` parity); current P62
  does whole-file read, not retrieval
- **P67** — OpenClaw-equivalent REM dreaming
  (out of scope; 6+ commits of work)

## Verification

- `pnpm --filter @lumen/core exec vitest run
  test/p62-memory-inject.test.ts` — 6 / 6 pass
  (format, schema, frozen-after-first,
  empty-snapshot skip, single-file partial render,
  closure-source-of-truth)
- `pnpm --filter @lumen/cli exec vitest run
  test/p62-batch.test.ts` — 8 / 8 pass
  (empty file, benign body, poisoned entry
  blocked, secret_exfil threat, tool_inject
  threat, mixed entries, headers preserved, 4-pattern
  set pin)
- 680 / 680 core tests + 476 / 487 cli tests pass
  (3 pre-existing P54 baseline fence-off fails
  unrelated)
- `pnpm --filter @lumen/core typecheck` and
  `pnpm --filter @lumen/cli typecheck` clean
- `pnpm --filter @lumen/cli exec tsc -b --force`
  → `apps/cli/dist/index.js` mtime 2026-08-13
- End-to-end smoke test via direct node: a
  poisoned USER.md entry was replaced with
  `[BLOCKED: USER.md entry contained pattern:
  system_override. Removed from system prompt;
  original kept in USER.md for inspection.]` in
  the snapshot; the on-disk file was unchanged.