# P62 — 4-framework cross-session memory comparison

> Fetched 2026-08-13. The 2026-07-07 evidence in
> `docs/p19.5-meta-reflector-design-basis.md` is **partially stale**:
> it concluded "OpenClaw has no public memory architecture", but
> the local `~/workspace/openclaw-main/` checkout (post-2026-08-06
> main) ships a complete `memory-host-core.ts` + `memory-host-sdk`
> + `memory-host-search.ts` + dreaming plugin. This document is the
> current snapshot.

## 1. Storage shape

| Framework | Path | Format | Trust |
|---|---|---|---|
| **Hermes** | `~/.hermes/<profile>/memories/MEMORY.md` + `USER.md` | `§`-delimited entries in 2 files | ❌ none |
| **OpenClaw** | `<workspace>/MEMORY.md` (canonical) + `memory/**/*.md` (daily-notes) + `memory/dreaming/*.md` (REM) + event-log.json | markdown files, file = 1 unit | ❌ none |
| **LangGraph** | `BaseStore` (any backing) — `namespace tuple + key` to JSON doc | JSON doc per (ns, key) | ❌ none (policy lives outside) |
| **Claude Code** | `~/.claude/projects/<repo>/memory/MEMORY.md` (auto) + 4 CLAUDE.md scopes (managed/user/project/local) | markdown | ❌ none |
| **Lumen (P62)** | `~/.lumen/MEMORY.md` + `USER.md` (already on disk via `lumen memory sync`) | markdown | ✅ `trust` 0-1 on records (P19.5) |

## 2. System prompt injection

| Framework | Mechanism | Frozen? | Cache-safe? |
|---|---|---|---|
| **Hermes** | `MemoryStore.load_from_disk` → `_system_prompt_snapshot` → injected as one block on session start (`tools/memory_tool.py:178-211`) | ✅ snapshot | ✅ "stable for the entire session (prefix-cache invariant holds)" — explicit comment line 195-197 |
| **OpenClaw** | `buildMemorySection` → spread into system prompt + `cacheStablePromptPrefix` keyed on `memorySection` (`src/agents/system-prompt.ts:1006-1075, 1185`) | ✅ hash-keyed | ✅ `cacheStablePromptPrefix` re-uses the cached prefix when memorySection is unchanged |
| **LangGraph** | Long-term memory: `store.search(namespace, filter, query)` per turn (no auto-inject — model calls the search tool). Short-term = state. | ❌ live query | N/A — not injected |
| **Claude Code** | Loads "first 200 lines or 25KB" of `~/.claude/projects/<repo>/memory/MEMORY.md` + the 4 CLAUDE.md scopes on session start | ✅ once per session | ✅ explicit 200-line / 25KB cap to bound prefix growth |
| **Lumen (P62)** | `loadMemorySnapshot()` at composition → frozen snapshot object → `createMemoryInjectMiddleware` pushes block via `appendDynamicChunk` on first call only | ✅ snapshot, closure-captured | ✅ `appendDynamic` routes through the P31.1 cache boundary marker (dynamic suffix, not standalone `{role:'system'}` message) |

## 3. Mid-session write

| Framework | Tool | When |
|---|---|---|
| **Hermes** | Single `memory` tool, 3 actions: add / replace / remove (substring match) | Mid-session (model decides). Writes to disk. System-prompt snapshot is **NOT** updated. |
| **OpenClaw** | `write_file` (general); during memory-flush window, `wrapToolMemoryFlushAppendOnlyWrite` restricts writes to append-only on the MEMORY.md path (`src/agents/agent-tools.read.ts:646-735`) | Mid-session, with append-only guard during flush |
| **LangGraph** | `store.put(namespace, key, value)` from graph nodes | Mid-session (graph-decided) |
| **Claude Code** | `/memory` UI toggle; model auto-writes when it judges a fact is durable | Mid-session, model-decided |
| **Lumen (P62)** | None — P62 is the READ path only. P63 follow-up adds reflection auto-promote (the WRITE path) | — |

## 4. Threat pattern scan

| Framework | Scan location | Pattern set |
|---|---|---|
| **Hermes** | `MemoryStore._sanitize_entries_for_snapshot` on every load | `tools/threat_patterns.py` "strict" scope, ~20 patterns, includes system_override + prompt_leak + tool_inject + secret_exfil + … |
| **OpenClaw** | `setup.migration-snapshot.ts:24` lists files to scan; full pattern library elsewhere | Larger library (QMD-side + memory-flush-side) |
| **LangGraph** | N/A — Store is a generic key-value, no content-level scanning | N/A |
| **Claude Code** | ❌ no documented scan (model-curated; user is the gate) | N/A |
| **Lumen (P62)** | `loadMemorySnapshot()` on every load; minimal 4-pattern set (system_override / prompt_leak / tool_inject / secret_exfil); full library deferred to P65 | 4 patterns (P62); ~20 patterns (P65) |

## 5. Cross-session sharing scope

| Framework | Scope | Mechanism |
|---|---|---|
| **Hermes** | per-profile (`HERMES_HOME` env) | `get_hermes_home() / "memories"` |
| **OpenClaw** | per-workspace, multi-agent shared via `agentIds` array | workspace `MEMORY.md` + per-agent overrides |
| **LangGraph** | per-deployment (Store instance) | configurable |
| **Claude Code** | per-repo (git path hash) for auto memory; per-user for CLAUDE.md | `~/.claude/projects/<hash>/` |
| **Lumen (P62)** | per-user (`~/.lumen/`) | already aligned with `lumen memory sync` |

## 6. Why Lumen is not just "copy Hermes"

Lumen has 3 unique properties none of the 4 frameworks share:

1. **`records` table with `trust` 0-1 + asymmetric feedback** (P19.5) —
   closer to Hermes `fact_feedback` than to markdown-only.
   P62's snapshot render is markdown-only (to keep P62 1-2 commit),
   but P63's reflection auto-promote can use `trust >= 0.6` as the
   cut-off (already in `lumen memory sync` default).
2. **`sqlite-vec` vector backend** (P5.1) + `retriever.ts` (P10.x) —
   cross-session retrieval is already in tree. LangGraph's `Store`
   has semantic search; Lumen has it too. P62 doesn't wire it
   (1-2 commit budget) but the data path is ready.
3. **`StablePromptCache` + P31.1 cache boundary marker** —
   system prompt is **byte-stable for the entire session** by
   construction. Hermes achieves the same property via snapshot
   discipline; OpenClaw via `cacheStablePromptPrefix`. P62 rides
   on the existing Lumen invariant — fewer moving parts.

## 7. Why we are NOT shipping OpenClaw's REM dreaming

`docs/p19.5-meta-reflector-design-basis.md` §2.3 (2026-07-07 fetch)
concluded "OpenClaw has no public memory architecture". The local
checkout now reveals the full dreaming system, but the scope
analysis holds:

- **REM dreaming** = `memory/dreaming/*.md` markdown files
- **QMD indexing** = `qmd create` collection + vector index
- **Promotion replay-safe** = each promotion is idempotent;
  reruns reconcile instead of duplicating
- **Compaction** = oldest auto-promoted sections compacted to
  stay under bootstrap budget

The 4 pieces together = 6+ commits of work. P62 budget is 1-2
commits. Documented as future P-ticket (P66 candidate).

## 8. Source URLs (verified 2026-08-13)

- **LangGraph long-term memory** —
  https://docs.langchain.com/oss/python/langgraph/memory
  (fetched 2026-08-13, status 200, 882KB, "Long-term memory stores
  user-specific or application-level data across sessions and is
  shared across conversational threads. State is persisted to a
  database using a checkpointer so the thread can be resumed at
  any time. The Store currently supports both semantic search and
  filtering by content.")
- **LangGraph overview** —
  https://docs.langchain.com/oss/python/langgraph/overview
  (fetched 2026-08-13, 812KB, "Create stateful agents with both
  short-term working memory for ongoing reasoning and long-term
  memory across sessions.")
- **Claude Code memory** — `https://code.claude.com/docs/en/memory.md`
  (fetched 2026-07-07, ~3KB, key clauses cited in
  `docs/p19.5-meta-reflector-design-basis.md` §2.2)
- **Hermes** — `~/.hermes/hermes-agent/tools/memory_tool.py:178-211`
  (local source, frozen snapshot + threat scan on load)
- **OpenClaw** — `~/workspace/openclaw-main/src/plugin-sdk/memory-host-core.ts:464-470`
  + `src/agents/system-prompt.ts:1006-1075, 1185`
  + `src/agents/agent-tools.read.ts:646-735` (local source,
  canonical MEMORY.md + cacheStablePromptPrefix + flush append-only)
