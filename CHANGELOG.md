# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/) on the public package surface
(`@lumen/core`, `@lumen/llm`, `@lumen/memory`, `@lumen/mcp`, `@lumen/tools`,
`@lumen/skills`, `@lumen/config`).

Test counts are point-in-time totals across the monorepo. The pre-1.0 series
(`0.x.y`) does not promise API stability; breaking changes are recorded as
**Changed** entries with a note about the migration path.

## [0.9.0] — 2026-06-16 — P8 Release prep

**Totals:** 3 commits (1a647ca, 58e6ee1, f8943a3), 24 files total,
~+823 lines, 0 test delta, 0 code delta. Typecheck clean. Biome clean.

### Added
- `CHANGELOG.md` (this file) — Keep-a-Changelog-style P0–P8 narrative
  with commit SHAs, test-count deltas, and migration notes for the
  P7 source-incompatible changes.
- **Package-level READMEs.** Every package under `packages/` ships
  its own `README.md`. `@lumen/core` / `@lumen/llm` / `@lumen/memory`
  get full READMEs with the public surface, quick start, and code
  samples; the other 7 get shorter role + endpoint-matrix +
  quick-start READMEs. README in the repo root also gains an
  updated test count (566 → 887).
- **npm descriptions on 7 packages.** `package.json` `description`
  field added to `@lumen/config`, `@lumen/core`, `@lumen/llm`,
  `@lumen/mcp`, `@lumen/memory`, `@lumen/skills`, `@lumen/tools`.
  The other 3 (`@lumen/desktop-bridge`, `@lumen/editor-bridge`,
  `@lumen/server`) already had descriptions.

### Changed
- `docs/ARCHITECTURE.md` updated: `BaseVectorMemoryStore`,
  `BaseProviderPool`, `BaseMutex` added to the base-contracts table.
  Adjacent-bridges section documents `@lumen/server`,
  `@lumen/desktop-bridge`, `@lumen/editor-bridge`. A new "No
  global locks" item under "What is intentionally NOT in core"
  documents the `concurrency` module without claiming a global
  re-entrant lock.
- **All 11 packages bumped to 0.9.0** (was 0.1.0 across the board).
  The version now reflects P0 → P8 progress. All packages remain
  `"private": true` — this is a documentation-grade version bump,
  not a publishable release.

### Fixed
- 4 pre-existing Biome format issues in `package.json` files
  (`files: ["dist"]` inline; trailing newline) for `@lumen/mcp`,
  `@lumen/server`, `@lumen/desktop-bridge`, `@lumen/editor-bridge`.

## [0.8.0] — 2026-06-16 — P7 Framework internal cleanup

**Totals:** 2 feature commits / 1 chore, 4 new files / 12 modified, +767
lines, +12 tests (875 → 887), 81 test files, 11 packages, 74 commits on
`main`. Typecheck clean. Biome clean.

### Added
- **`BaseVectorMemoryStore` (P7.1, commit `a53e80c`).** New abstract class
  in `packages/core/src/memory/index.ts` that extends `BaseMemoryStore` with
  an `abstract vectorSearch(embedding, k?)`. Replaces the banned
  duck-typing pattern in `packages/memory/src/retriever.ts`. `SqliteStore`
  now extends `BaseVectorMemoryStore`; the retriever's constructor
  parameter type is narrowed from `BaseMemoryStore` to
  `BaseVectorMemoryStore` so the "supports vectors" question becomes a
  compile-time check.
- **Concurrency module (P7.2, commit `c8f11e0`).** New
  `packages/core/src/concurrency/` directory ships `BaseMutex`, the
  concrete `Mutex` (FIFO promise-chain), `MutexOptions`, and
  `AcquireTimeoutError extends AgentError`. Public extension surface for
  code that needs to serialize state across `await` points.
- **ProviderPool round-robin cursor safety (P7.2).**
  `ProviderPool.candidatesFor` is now `async` and runs inside
  `mutex.runExclusive(...)`, making the read-modify-write of
  `roundRobinIndex` atomic. `register` / `unregister` stay synchronous
  (JS single-threaded event loop makes check+mutate atomic without a
  lock). New regression tests: 3 concurrent `chat` calls verify union
  coverage; 60 concurrent calls verify strict round-robin distribution
  (each provider hit 20 times).

### Changed
- `ProviderPool.candidatesFor` is now `Promise<ReadonlyArray<BaseProvider>>`
  (was `ReadonlyArray<BaseProvider>`). `runWithFailover` and the stream
  path now `await` it. This is source-incompatible for any caller that
  directly invoked `candidatesFor` (none in the public API — it is
  `private`).
- `HybridRetriever.store` field type narrowed from `BaseMemoryStore` to
  `BaseVectorMemoryStore`. This is type-incompatible for any caller that
  passed a `BaseMemoryStore` that is not a `BaseVectorMemoryStore`. Use
  `TextOnlyRetriever` for that case.

### Fixed
- `ProviderPool` round-robin cursor race: under concurrent `chat` /
  `stream` calls the cursor's RMW was non-atomic, occasionally routing
  the same provider twice or skipping one. Now serialized through the
  pool's private `Mutex`. The 60-concurrent-call test fails on the
  pre-P7.2 implementation.
- `Mutex` waiter counter double-decrement bug: the first implementation
  decremented `waiters` on both the success path (when the holder
  releases) and the `finally` block, causing `pending` to report a value
  one lower than the actual queue depth. Fixed by redefining `waiters`
  as queue-total depth (including the holder) and exposing `pending` as
  `waiters - (held ? 1 : 0)`.

## [0.7.0] — 2026-06-15 — P6 Composable layers

**Totals:** 3 feature commits / 1 chore, +1,707 lines, +39 tests
(836 → 875), 71 commits. Typecheck clean.

### Added
- **P6.1 RAG pipeline (commit `631fd99`).** `BaseRagPipeline` abstract
  contract + `RagPipeline` default in `@lumen/memory`. Composes
  caller-supplied `ChunkerFunction`, `TextEmbedder` (P5.1), and
  `BaseVectorBackend`. `ingest` is idempotent (re-ingest replaces prior
  chunks atomically); `retrieve` returns `Citation[]` with offsets and
  scores. +10 tests.
- **P6.2 Local-inference providers (commit `7966591`).** `LlamaCppProvider
  extends OpenAICompatibleProvider` for llama.cpp's OpenAI-compatible
  HTTP server. Default `baseUrl` `http://127.0.0.1:8080/v1`, no required
  `apiKey`. Ollama E2E fixtures add +5 streaming tests (multi-delta
  coalesce, 5xx mid-stream, heartbeat skip, multi-turn round-trip,
  system message at position 0). +6 llama-cpp + 5 ollama tests.
- **P6.3 ProviderPool (commit `75b46bd`).** `BaseProviderPool extends
  BaseProvider` + `ProviderPool` default in `@lumen/core`. Four
  strategies: `round-robin`, `name` (pin to specific id), `capability`
  (filter by capability flags), `weighted` (weighted random with
  injectable PRNG). `runWithFailover` walks strategy-ordered candidates
  and collects `ProviderError` into a `PoolExhaustedError` carrying the
  full `attempts` array. Stream failover is best-effort: commit on
  first yielded event. Capabilities are OR-merged; `maxContextTokens`
  takes the max. +18 tests covering all 4 strategies, failover paths,
  stream commit-on-first-event, and the `PoolExhaustedError instanceof
  AgentError` chain.

## [0.6.0] — 2026-06-15 — P5 Embedding, chunking, and provider tests

**Totals:** 4 feature commits / 1 chore, +1,489 lines, +46 tests
(790 → 836), 67 commits. Typecheck clean.

### Added
- **P5.1 Embedding bridge (commit `ec2118e`).** `EmbeddingSource`
  structural type in `@lumen/memory` that the retriever accepts. No
  `@lumen/llm` import — keeps `@lumen/memory` provider-agnostic.
- **P5.2 `chunk_text` (commit `90ac781`).** New tool in `@lumen/tools`
  with char / paragraph / sentence splitting strategies and overlap
  support. CJK punctuation (`。！？`) is recognized as a sentence
  terminator with or without surrounding whitespace.
- **P5.3 Mistral streaming + tool_use E2E (commit `85058c5`).** +5
  fixtures.
- **P5.4 Anthropic prompt caching (commit `b2957f7`).**
  `AnthropicSystemBlock` / `AnthropicCacheControl` interfaces plus
  `anthropicSystemBlocks` / `anthropicCacheTools` `providerOptions`
  channels. `AnthropicSystemBlockSchema` Zod validation. +6 tests.

## [0.5.0] — 2026-06-15 — P4.3 Mistral provider

**Totals:** 1 commit, +0.5 commit, 62 commits, 790 tests.

### Added
- **P4.3 Mistral provider (commit `fd74df0`).** `MistralProvider extends
  OpenAICompatibleProvider`, overrides `embed()` to POST against
  `/v1/embeddings` with `mistral-embed`. Capabilities `vision: true`
  (Pixtral family). Pre-P4.3 baseline: 74 files / 790 tests / 0 fail.

## [0.4.0] — 2026-06-15 — P4 Web + Google Gemini

### Added
- **P4.1 Web search + fetch (commit `62853b5`).** `@lumen/tools` adds
  `web_search` and `web_fetch`.
- **P4.2 Google Gemini provider (commit `93df03d`).** First-class
  provider in `@lumen/llm`.

## [0.3.0] — 2026-06-12 — J/K/L/M Bridge packages + cross-cutting

### Added
- **`@lumen/server` (commit `d9a0dc0`).** HTTP + WebSocket adapter.
- **`@lumen/desktop-bridge` (commit `97791a4`).** Tauri IPC.
- **`@lumen/editor-bridge` (commit `cf78262`).** VSCode + JetBrains
  editor adapter.
- **Sub-agent delegation (commit `bdd7cc0`).** `K1.x` — orchestrator
  can spawn child agents with isolated context.
- **Security audit module (commit `bdd7cc0`).** `M4.x` — dangerous
  command and PII detection.
- **Cron scheduler (commit `bea3932`).** `K2.x` — scheduled job
  registry with notification delivery.
- **Plan/act mode (commit `b249162`).** `K3.x` — explicit two-phase
  agent loop (read-only planning, then tool-bearing execution).
- **Multi-user collaboration (commit `02e42f8`).** `K4.x` — namespace
  isolation across users.
- **Telemetry collector (commit `e2cc9e5`).** `H3.x` — opt-in usage
  metrics with redacted payloads.
- **`lumen` doctor `--verbose` / `update` (commit `df7bfc0`).** `I7.x`.
- **Model / config / tools subcommands (commit `c3a422d`).** `I6.x`.

## [0.2.0] — 2026-06-08 — H/I E/F Working memory + reflection

### Added
- Working memory ring buffer (E9.x — `0f3cda0`).
- Cross-session retriever (E10.x — `ccfbb98`).
- Pluggable vector backend with sqlite-vec + brute-force fallback
  (E8.x — `c4603f2`).
- Reflection + fact extraction (E8.x — `8c1c059`).
- Conflict detection in memory (E9.x — `6a4d946`).
- Skill triggering (keyword + embedding) (F3.x — `f323eb5`).
- Skill auto-evolution (F4.x — `90c241e`).
- Trajectory hook for self-creating skills (F5.x — `0cbf364`).
- Long-term user profile builder (E7.x — `8392572`).
- Docker sandbox (D12.x — `ad8d418`).
- Toolset grouping + lazy loading (D11.x — `f5dd425`).
- Structured logging: `BaseLogger` / `ConsoleLogger` / `PinoLogger`
  (H2.x — `04636f0`).
- MCP Streamable HTTP transport, MCP 2025-03-26 spec
  (`55301cc`).
- `gh` CLI bridge for PR/issue operations (D9.x — `45389a8`).
- Date / env / whoami meta tools (D10.x — `bb62354`).

## [0.1.0] — 2026-06-08 — Bootstrap (P0 / P1 / P2 / P3)

### Added
- **P0 Bootstrap.** Monorepo + pnpm workspaces + turborepo.
  `docs/ARCHITECTURE.md`, `docs/DEVELOPER.md`, `docs/SECURITY.md`,
  `docs/L1-AUDIT.md`, `tsconfig.base.json` (strict + noUncheckedIndexedAccess),
  Biome config, `Dockerfile`. `@lumen/config` MVP (YAML load + profile
  switch). `BaseProvider` / `BaseTool` / `BaseMemoryStore` / `BaseSkill`
  / `BaseTransport` contracts. `Agent` runtime with 26 unit tests.
- **P1 Tools.** Filesystem tools (read/write/patch/list/search) — 27
  tests. Terminal + Git tools with `ShellSandbox` (D7–D13).
  Streaming: `Agent.streamRun` yields `RunEvent` generator; TUI
  renders deltas. Ink/React TUI chat with state machine + composition
  root. MVP CLI: `run` / `doctor` / `chat` (6 tests).
- **P2 Memory.** `InMemory` + `Sqlite` stores with FTS5 / WAL, contract
  test suite, CLI wiring.
- **P3 Skills / MCP.** Markdown skill registry + CLI integration. MCP
  stdio transport + `lumen doctor` round-trip. `OpenAICompatibleProvider`
  (10 tests). Anthropic Messages API provider (C4.x). Ollama local
  provider (C5.x).
