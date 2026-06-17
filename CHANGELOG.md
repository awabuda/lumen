# Changelog

All notable changes to Lumen are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/) on the public package surface
(`@lumen/core`, `@lumen/llm`, `@lumen/memory`, `@lumen/mcp`, `@lumen/tools`,
`@lumen/skills`, `@lumen/config`).

Test counts are point-in-time totals across the monorepo. The pre-1.0 series
(`0.x.y`) does not promise API stability; breaking changes are recorded as
**Changed** entries with a note about the migration path.

## [0.10.0] — 2026-06-16 — P9 Hardening (errors, safety, failure fallback)

**Totals:** 4 feature commits (2108a00, f65973a, 56f6333, 53e65c3), 4 new
files / ~28 modified, ~+1,400 lines, +33 tests (887 → 920), 82 test
files, 11 packages, 43 commits on `main`. Typecheck clean. Biome clean
on touched files.

### Added
- **`withRetry` helper (P9.1, commit `f65973a` part).** New
  `packages/core/src/retry.ts` exports `withRetry<T>(fn, config?)` with
  `maxAttempts` (default 3), `initialDelayMs` (default 100),
  `maxDelayMs` (default 5000), `backoffFactor` (default 2), `jitter`,
  `shouldRetry`, `signal`, and injectable `sleep` for tests. Throws
  `RetryExhaustedError extends AgentError` (with `cause: lastError`,
  `attempts: number`) when the budget is spent, or `RetryAbortedError`
  when the signal aborts. `defaultShouldRetry` honors a `retryable`
  flag on the error first, then falls back to the `ProviderError`
  status heuristic (5xx / 408 / 429).
- **Circuit breaker (P9.4, commit `53e65c3` part).** New
  `packages/core/src/agent/circuit-breaker.ts` ships a
  `CircuitBreaker` class with a closed / open / half-open state
  machine, configurable `failureThreshold` (default 5) and
  `cooldownMs` (default 30_000). Throws `CircuitOpenError extends
  AgentError` carrying the offending `providerId` and `retryAfterMs`.
  8 unit tests cover the state machine and the boundary conditions.
- **`ProviderPool` circuit integration (P9.4).**
  `candidatesFor(...)` filters out providers whose breaker is open;
  `runWithFailover` calls `recordSuccess` on the chosen provider and
  `recordFailure` on the failed candidates. An open circuit produces a
  `CircuitOpenError` that is itself recorded as a non-fatal skip — the
  loop continues to the next candidate without counting it against
  the breaker (no point in punishing the breaker for being open).
  Back-compat: no `circuit` option = behavior unchanged.
- **DefaultSandbox path-traversal defense (P9.3, commit `53e65c3`
  part).** `DefaultSandbox.run` now rejects a `cwd` whose resolved
  path falls outside `workspaceRoot`. Throws `ConfigError` with
  `field: 'cwd'`. 4 new tests cover relative-cwd, absolute-cwd,
  parent-`..` traversal, and the legitimate same-root case.
- **web_fetch streaming size cap (P9.3).** The fetch path now streams
  chunks and aborts via `reader.cancel()` once the per-byte
  accumulator exceeds `maxBytes`. A hostile or lying `Content-Length`
  still cannot OOM the agent. 3 new tests cover the abort paths.

### Changed
- **78 `throw new Error(...)` sites now typed (P9.2, commit
  `56f6333`).** Every site audited and reclassified:
  `ConfigError` (resource / registration / strategy errors),
  `ValidationError` (input / parameter errors), `ProviderError` (LLM
  runtime errors, with `providerId` + `retryable`),
  `AbortError` (user cancellation), `ToolError` (tool-internal
  invariant, requires `toolName` in the options), `SkillConfigError` /
  `SkillParseError` (in a new `packages/skills/src/errors.ts` to keep
  the package decoupled from `@lumen/core` dist), and a new
  `MutexDisposedError` (lives next to the mutex). Coverage by
  package: core 25, skills 6, llm 15, memory 6, tools 11, mcp 1.
  Catching logic can now `instanceof`-discriminate without parsing
  the message.
- **4 LLM providers integrate `withRetry` (P9.1).** OpenAI-compatible,
  Anthropic, Gemini, Mistral — their `performFetch` rewrapped so a
  non-2xx response throws `ProviderError` (with status + retryable)
  inside the `doFetch` closure, and the closure is then passed to
  `withRetry` when `this.retry` is configured. Back-compat: no
  `retry` option = behavior unchanged (P8 callers unaffected).
- **`terminal` tool returns `policy-violation` instead of throwing
  (P9.3).** argv[0] containing a shell metacharacter is no longer an
  unhandled `Error` — it returns a structured refusal result. Honors
  CLAUDE.md rule #7 ("No try/catch that swallows" — better: don't
  throw, return a typed refusal).
- **Biome `noNonNullAssertion` disabled (P9.0, commit `2108a00`).**
  TS narrowing makes `!` safe in our codebase; Biome was flagging
  legitimate uses in `pool.ts` / `retriever.ts`. Set to `"off"` in
  `biome.json` `style.noNonNullAssertion`.

### Migration notes
- Catchers that used to match `err.message.includes('disposed')` on
  the mutex now use `instanceof MutexDisposedError`. The string match
  still works (the message is preserved), but the typed check is
  preferred.
- `ToolError` callers **must** pass the second `options` argument
  (with `toolName`) — the typecheck enforces this. Sites that omit
  the second arg will see `error TS2554: Expected 2 arguments`.
- `ProviderError` import path: it lives in
  `packages/core/src/errors/index.ts`, **not** in
  `packages/core/src/message/index.ts`. The package barrel
  `@lumen/core` re-exports it.
- `MutexDisposedError` lives in
  `packages/core/src/concurrency/mutex.ts` and is re-exported from
  `packages/core/src/concurrency/index.ts` and the core barrel.

## [0.10.0] — 2026-06-17 — P10 Input validation for @lumen/memory

**Totals:** 1 commit (`4031a5d`), 2 new files / 8 modified, +507/-29 lines,
+27 tests (920 → 947), 83 test files. Typecheck clean. Biome clean.

### Added
- **`packages/memory/src/schemas.ts`** (new, 182 lines) — six Zod
  schemas covering every user-supplied input type for
  `@lumen/memory`:
  - `SqliteStoreConfigSchema` (path non-empty, optional `readonly`
    and `verbose` function)
  - `RagPipelineOptionsSchema` (three collaborators typed as
    `z.unknown()` — see Migration note below)
  - `ProviderEmbedderOptionsSchema` (model non-empty,
    `dimensions` int+optional, `signal` AbortSignal)
  - `MemoryQuerySchema` (`minTrust` 0–1, `limit` int+)
  - `IngestInputSchema` (+ internal `RagChunkSchema` with
    `endOffset >= startOffset` refine)
  - `RetrieveInputSchema` (query non-empty, `limit` int+)
  - `parseOrThrow(schema, input, field)` helper that re-shapes a
    `ZodError` into the typed `ValidationError` from `@lumen/core`
    (chained as `cause`) and embeds the field path in the message.

- **Validation wired at 6 entry points** in `@lumen/memory`:
  - `SqliteStore` constructor
  - `InMemoryStore.search` and `SqliteStore.search` (both)
  - `createProviderEmbedder` factory
  - `RagPipeline` constructor, `RagPipeline.ingest`, and
    `RagPipeline.retrieve`

- **27 new tests** in `test/schemas.test.ts` — `parseOrThrow` helper
  + valid/invalid paths for each schema (empty strings, out-of-range
  numerics, unknown extra keys, `z.unknown()` optionality).

### Changed
- `packages/memory/package.json` — added `zod: ^3.23.0` to
  `dependencies` (matching the 9 sibling packages).
- Two existing tests in `test/embedder.test.ts` and
  `test/rag.test.ts` were updated to match the new
  `ValidationError` message shape (Zod's structured path-based
  message replaces the previous hand-rolled text).

### Migration notes
- **`RagPipelineOptionsSchema` uses `z.unknown()` for `embedder` /
  `backend` / `chunker`.** The naive `z.object({}).passthrough()`
  would clone the input, losing the class prototype chain on real
  instances (`BruteForceVectorBackend`, `TextEmbedder`,
  `ChunkerFunction`) and producing `backend.upsert is not a
  function` at runtime. `z.unknown()` preserves the reference.
  TypeScript continues to enforce the actual contract at the call
  site; the schema's job is to reject unknown extra keys.
- **No public type changes.** Valid inputs behave identically. The
  only observable difference is the error message text on invalid
  input — e.g. `"options.model is required"` →
  `"schema for options: model: model must not be empty"`. Callers
  that match on the old text should switch to
  `instanceof ValidationError` + check the `field` property.
- **No version bump** in this commit: the 0.10.0 series continues.
  Next non-breaking feature batch will bump to 0.11.0.

## [0.10.0] — 2026-06-17 — P11 Tooling/test hygiene (biome cleanup, env-var footgun)

**Totals:** 1 commit (`2444b72`), 132 files modified, +692/-629 lines, no test
count change (947 → 947), 11 packages, 47 commits on `main`. Typecheck
clean. `pnpm exec biome check` clean across 242 files (was 235 errors at
the start of the pass).

### Fixed
- **Biome cleanup pass.** 235 errors → 0. Bulk auto-fix
  (`biome check --write --unsafe`) handled 228 of them. The remaining 7
  were semantic and required judgement: `noAssignInExpressions` in
  `apps/cli/test/default-command.test.ts:51-52` (refactored to
  explicit `if`/block form), `noImplicitAnyLet` + `useYield` in
  `packages/core/test/agent-stream.test.ts:108,189` (added explicit
  `Extract<StreamEvent, { type: 'run:end' }>` and `biome-ignore` for the
  throwing-stream generator), and 3 `noExplicitAny` abstract-class test
  guards. After fixing those, biome surfaced 4 more identical guards in
  the bridge test files (`editor-bridge`, `server`, `desktop-bridge`).
- **`process.env.X = undefined` footgun re-triggered.** A late-2025
  `biome --write` run had auto-converted `delete process.env.X` to
  `process.env.X = undefined` in 9 sites across 5 test files (the audit
  had flagged one but missed eight). The P9 audit's `pitfalls.md` entry
  for this footgun fired again — exactly the documented symptoms
  (`received: "undefined"` for the `logging.level` enum, expected env
  vars becoming the string `"undefined"`). All 9 sites now use `delete`
  with a per-site `biome-ignore lint/performance/noDelete` comment
  explaining why.
- **`ChatMessage` exported from `@lumen/skills`.** The `as any` casts in
  `packages/skills/test/evolver.test.ts` and
  `packages/skills/src/trajectory-hook.ts:73` were replaced with
  `as ReadonlyArray<ChatMessage>` / `as ChatMessage[]`. Marked the
  local `ChatMessage` interface as `export` so it can be imported from
  tests and adjacent prod code.
- **MCP `discover.ts:36` `noImplicitAnyLet`** — annotated the
  `let transport` declaration with the abstract `McpTransport` type and
  added the type-only import to the existing `import { ... }` group.
- **Tools `text/chunker.ts:237,265`** — added `biome-ignore` for the
  `RegExp.exec()` `while ((m = re.exec(text)) !== null)` iteration
  idiom (splitting the assignment+test would only obscure intent).

### Notes
- **No version bump**: tooling/test hygiene, no public API change.
  CHANGELOG 0.10.0 still covers everything in flight.
- **Pitfalls.** The `process.env.X = undefined` footgun is already
  documented in `~/.hermes/skills/lumen-agent-framework/references/pitfalls.md`.
  This pass did not add a new entry — the existing one covers both the
  failure mode and the correct fix.
- **Push status:** same — remote unreachable, no retry. Local commits
  are safe.

## [0.10.0] — 2026-06-17 — P13 SqliteStore lifecycle state machine

**Totals:** 1 commit (`2803c5e`), 2 files (1 new), +292/-46 lines,
+14 tests (947 → 961), 12 packages, 51 commits on `main`.
Typecheck clean. Biome clean.

### Added
- **Three-state lifecycle machine** in `SqliteStore`:
  `'uninit' | 'ready' | 'closed'`. Replaces the single
  `initialized: boolean` flag. Every public method dispatches
  on the state and throws a typed `ConfigError` on a
  lifecycle violation; `dispose()` is idempotent.

### Fixed
- **3 silent footguns in the previous `init()` flow:**
  1. `init()` no-op'd on a second call (`if (initialized) return`)
  2. `init()` after `dispose()` would crash on a closed DB
  3. `init()` that threw partway left the instance in a
     half-baked state where a retry would re-run DDL against a
     corrupted file
- **5 public methods that escaped sync throws.** `get`, `search`,
  `listSessions`, `getSession`, and `getSessionMessages` used
  `Promise.resolve(syncWork())` which escaped a sync throw from
  the `s` accessor. A lifecycle error would surface as a
  synchronous throw, not a rejected promise — `await store.get('x')
  .catch(...)` would miss it. All five now use the
  `try { ... } catch { reject }` wrapper pattern that `put`,
  `createSession`, `appendMessage`, and `prune` already used.

### Tests
- new file: `packages/memory/test/init-order.test.ts` — 14 cases
  covering every state-machine transition: rejects every public
  method before init(), rejects `init()` called twice
  ("already ready"), rejects `init()` called after dispose
  ("create a new"), rejects methods after dispose, `dispose()`
  is idempotent, `dispose()` before `init()` is a no-op, init
  failure on a corrupted file leaves the instance in `'closed'`,
  validates config at the constructor boundary, and pins a
  happy-path read-after-write round-trip.

### Notes
- **No version bump**: internal hardening, no public API change.
  The new error messages are added but the *types* of the existing
  `ConfigError` rejects are unchanged.
- **No `reset()` or `reinit()` method** by design. Single-use
  instances keep the lifecycle simple; long-lived daemons that
  need to re-open construct a new `SqliteStore`.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P15 better-sqlite3 native rebuild automation

**Totals:** 1 commit (`0a75e2b`), 2 files modified, +13/-2 lines,
no test count change (961 → 961), 12 packages, 56 commits on `main`.
Typecheck clean. Biome clean.

### Added
- **`pnpm.onlyBuiltDependencies: ["better-sqlite3"]`** in the
  root `package.json`. pnpm blocks install scripts by default
  (supply-chain hardening). Whitelisting *just* `better-sqlite3`
  lets the package's own `install` hook run on every
  `pnpm install`, which re-downloads the prebuild that matches
  the current Node ABI. The whitelist is minimal and audited —
  no other package's install script runs.
- **`pnpm rebuild:native`** script at the root, which wraps
  `pnpm rebuild better-sqlite3 --filter @lumen/memory`. This
  is the fallback when the prebuild doesn't match (rebuilds
  from source via node-gyp; ~30s on M-series Macs).
- **`docs/L1-AUDIT.md`** updated to reference the new script
  with a one-liner copy-paste for the "I just upgraded Node
  and tests are broken" case.

### Decisions
- **Whitelist, not blanket allow.** Single-element allowlist
  keeps pnpm's supply-chain protection; we trust *this one*
  package's install script.
- **No `postinstall` in `@lumen/memory` itself.** The package's
  own `install` script (whitelisted to run) already handles
  prebuild download. Adding a redundant `postinstall` would
  force a slow from-source rebuild on every install.
- **Root-level `rebuild:native`, not package-level.** Future
  native deps (e.g. `sqlite-vec`'s Rust binding) can be added
  to the same `onlyBuiltDependencies` list and the same
  `rebuild` script without changing the package-level scripts.

### Notes
- **No version bump**: tooling only, no public API change.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P14 Sweep redundant `!` outside @lumen/llm

**Totals:** 1 commit (`cb06032`), 5 files modified, +48/-17 lines,
no test count change (961 → 961), 12 packages, 55 commits on `main`.
Typecheck clean. Biome clean.

### Fixed
- **`packages/config/src/loader.ts` (lines 109-120)** — replaced
  `path[path.length - 1]!` and `path[i]!` with const binding +
  explicit `undefined` check. The `noUncheckedIndexedAccess`
  option then propagates the type safely without the assertion.
- **`packages/memory/src/sqlite-store.ts:546`** — hoisted
  `query.embedding!` (redundant after truthy check) to
  `const r = query.embedding`; also pulled `.sort()` out of the
  chained call so the data flow is obvious.
- **`packages/tools/src/git/git.ts:234`** — `input.message!` was
  papering over the Zod schema's `optional()`. Replaced with
  local const + typed `ConfigError` defense-in-depth check
  (unreachable per the schema's `.refine()` but documents the
  invariant for the next reader).
- **`packages/llm/README.md` (2 sites) + `packages/core/README.md`
  (1 site)** — the apiKey `!` footgun that P12 cleaned from
  JSDoc also lived in two README quick-start snippets.
  Replaced with the same `if (!apiKey) throw new Error(...)`
  guard pattern.

### Sites left alone (real invariants, not footguns)
- `git.ts:161`, `gh.ts:105`, `default-sandbox.ts:148`,
  `terminal.ts:170`: `execArgv[0]!` / `request.command[0]!`
  sit on real invariants (Zod schema enforces `min(1)` array
  length).
- `default-sandbox.ts:89` `buf[end]!`: `while (end > 0 && ...)`
  guards `end > 0`.
- Test fixtures: `!` in those strings is a test-data
  exclamation, not a TS operator.

### Notes
- **No version bump**: internal hardening, no public API change.
- **Push status:** same — remote unreachable, no retry.

## [0.10.0] — 2026-06-17 — P12 Redundant `!` cleanup in @lumen/llm

**Totals:** 1 commit (`ade82fd`), 5 files modified, +23/-18 lines, no
test count change (947 → 947), 11 packages, 49 commits on `main`.
Typecheck clean. Biome clean.

### Fixed
- **3 JSDoc quick-start examples** in `mistral.ts:276`,
  `llm/index.ts:31, 42` showed `apiKey: process.env.X!` — a type-only
  assertion that silently passes `undefined` at runtime when the env
  var is unset. Replaced with the standard `if (!apiKey) throw new
  Error('X is required')` guard pattern in all 3 examples.
- **7 real-code sites** in `openai-compatible.ts:380, 478`,
  `anthropic.ts:462, 464`, and `ollama.ts:417, 420, 619` used
  `cond ? { x: expr! } : {}` with a redundant non-null assertion after
  a truthy check. The check already narrowed the type; the `!` was a
  no-op that also hid a double call to the same mapper. All 7 sites
  refactored to the `const x = expr; ...(x ? { x } : {})` shape — single
  call, shorthand property name, no assertion.

### Notes
- **No version bump**: pure refactor, no public API change.
- **`noNonNullAssertion` rule** stays disabled (P9.0 decision) — this
  pass targets the *redundant* subset only. Legitimate `!` in
  `packages/core/src/agent/pool.ts` (P9.4 circuit breaker) and similar
  sites is preserved.
- **Push status:** same — remote unreachable, no retry.

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
