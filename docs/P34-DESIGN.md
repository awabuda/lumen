# Phase B.1 — Memory markdown bridge (human-readable MEMORY.md / USER.md projection)

> **Scope**: close OPTIMIZATION-PLAN §3 B.1. The structured
> `SqliteStore` is the source of truth for facts / sessions
> / trust; this pass adds a *human-readable* projection to
> `~/.lumen/MEMORY.md` (the "agent remembers" file) and
> `~/.lumen/USER.md` (the "user facts" file) so the operator
> can `cat` the directory and immediately see what the agent
> has learned.

## 1. Why

`gateG_P3_observableLearning` flips from WARN to OK once a
fact stored in `SqliteStore.put(...)` is observable in a
human-readable file within the same `run` boundary. The
operator workflow becomes:

```
$ lumen run "remember that Postgres conn strings go in ~/.pgpass"
$ cat ~/.lumen/MEMORY.md
> ## Agent
> - Postgres conn strings go in ~/.pgpass (trust=0.7, kind=preference)
```

## 2. Boundary (architecture doc / P19+ rule)

- `core` stays pure: no fs imports (P19+ tier isolation).
- `apps/cli` composition root owns the bridge lifecycle
  (write-path: `afterRun` reflection → push deltas to bridge;
  read-path: startup → if md mtime > sqlite mtime, ingest
  back into sqlite).
- `memory` package ships a *pure-data* helper:
  `serializeFactsToMarkdown(records): string` and
  `parseMarkdownFacts(markdown): MemoryRecord[]`. The helper
  has no fs dep so it unit-tests in isolation; the bridge
  composition wiring lives in `apps/cli`.

## 3. Surface (per OPTIMIZATION-PLAN §3 B.1 §5)

```typescript
// packages/memory/src/markdown-bridge.ts
export const SERIALIZED_MARKDOWN_SCHEMA_VERSION = 1

export interface SerializedFact {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly trust: number
  readonly tags: ReadonlyArray<string>
  readonly createdAtIso: string
}

export const serializeFactsToMarkdown = (
  facts: ReadonlyArray<SerializedFact>,
  meta: { readonly generatedAtIso: string; readonly profile?: string },
): string

export const parseMarkdownFacts = (
  markdown: string,
): ReadonlyArray<SerializedFact>
```

The bridge in `apps/cli`:

```typescript
// apps/cli/src/memory-markdown-bridge.ts
export const createMemoryMarkdownBridge = (input: {
  store: BaseMemoryStore
  memoryMdPath: string
  userMdPath: string
  trustThreshold: number       // default 0.6
  syncOn: 'run-end' | 'meta-reflect' | 'manual'
}): MemoryMarkdownBridge

export interface MemoryMarkdownBridge {
  /** Push the records the agent learned this run to the
   *  human-readable files. Idempotent (same content → noop). */
  syncAfterRun(): Promise<void>

  /** Re-ingest user-edited md into sqlite (when md mtime
   *  is newer than the last sync). */
  ingestIfNewer(): Promise<void>
}
```

## 4. Decisions

1. **Source of truth stays SqliteStore.** Markdown is a
   projection — never authoritative. `ingestIfNewer()` only
   inserts facts with `source: 'user-md'` and trust =
   `min(recordedTrust, userTrustCeiling)` so user-edited
   facts don't silently promote past the original entry.
2. **Sync trigger = `run-end`.** Per OPTIMIZATION-PLAN §3
   B.1 §5, the first pass only fires on `afterRun`; the
   `meta-reflect` hook (cross-run trust delta) is a later
   P-ticket because MetaReflector writes facts on a
   different cadence.
3. **Manual `lumen memory sync` command** exposes the
   bridge for ops use without re-running the agent.
4. **Threshold default = 0.6.** Per the design doc; below
   0.6 = "agent isn't confident" and the record stays in
   sqlite only (the operator can still `lumen reflect meta`
   to inspect it).
5. **No core import.** `apps/cli` is the only call site.
   `packages/memory` ships the pure helpers.

## 5. Composition root wiring

```
┌─────────────────────────────────────────┐
│  Composition root (cli / gateway)       │
│  createMemoryMarkdownBridge({           │
│    store: SqliteStore,                  │
│    paths: { memory, user },             │
│  })                                     │
└───────────────┬─────────────────────────┘
                │ DI: still BaseMemoryStore
                ▼
┌──────────────────┐     run-end / start
│ SqliteStore      │◄──── syncAfterRun + ingestIfNewer
│ (truth: facts,   │
│  sessions,trust) │────► MEMORY.md / USER.md (projection)
└──────────────────┘
```

## 6. Failure modes

- **fs read fails** (permission, missing dir) → log to
  stderr, do NOT abort the agent run. The bridge is
  best-effort; the structured store stays authoritative.
- **Markdown parse returns 0 facts** → noop (the file is
  empty or was hand-cleared).
- **User-edited md has a malformed fact** (missing
  required field) → skip with a stderr line. NEVER throw
  on a parse error — the user is hand-editing.

## 7. Files

- `packages/memory/src/markdown-bridge.ts` (new, ~120 lines)
- `packages/memory/src/markdown-bridge.test.ts` (new, ~15 tests)
- `packages/memory/src/index.ts` (re-export helpers)
- `apps/cli/src/memory-markdown-bridge.ts` (new, ~180 lines)
- `apps/cli/src/memory-markdown-bridge.test.ts` (new, ~10 tests)
- `apps/cli/src/commands/memory.ts` (new, `lumen memory sync`)
- `apps/cli/src/composition.ts` (build the bridge; run-end hook)
- `apps/cli/src/index.ts` (register `lumen memory` subcommand)
- `apps/cli/src/product-gates.ts` (flip G-P3 row)
- `apps/cli/test/product-gates.test.ts` (gate update)
- `docs/MEMORY.md` (operator guide, new file)
- `TASKS.md` (P34 section + backlog update)
- `.changeset/p34-memory-markdown-bridge.md`

## 8. Verification

```bash
pnpm -r typecheck                                       # 0 errors
pnpm -r --filter '!@lumen/docs-site' test              # +25 tests
pnpm exec biome check packages/memory/src \
  apps/cli/src apps/cli/test                           # 0 errors
```

Monorepo target: 1844 → 1869 tests / 0 fail.

## 9. Completion criteria

- `lumen run "remember X"` produces a new line in
  `~/.lumen/MEMORY.md` (or `USER.md` based on `kind`)
- `lumen memory sync` writes the bridge manually
- `lumen doctor --product` G-P3 flips WARN → OK
- All 1844+ existing tests still pass (zero regression)