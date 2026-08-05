# @lumen/llm

## 0.16.3

### Patch Changes

- Updated dependencies [63e3a12]
  - @lumen/core@0.20.0

## 0.16.2

### Patch Changes

- Updated dependencies [b70d785]
  - @lumen/core@0.19.0

## 0.16.1

### Patch Changes

- Updated dependencies [3211dcc]
  - @lumen/core@0.18.0

## 0.16.0

### Minor Changes

- 76c5cfc: P23.9: small correctness fixes across the audit (fix #11, #25, #26, #27, #28, #29, #30, #31, #41). Highlights: `mergeArgs` uses a `Symbol` for the raw-string slot so a tool arg literally named `__raw__` no longer collides (#11); FTS5 tokenisation preserves CJK + accented characters (#25); `PlanSchema` enforces mutex on `approvedAt` / `rejectedAt` (#29); `ClusterOptionsSchema` is now exported (#30); the `MinimalProvider` interface in `core/src/plan/index.ts` tracks `BaseProvider.chat`'s real signature so mocks pass at runtime (#31); `createProviderEmbedder` forwards `dimensions` (#32, also covered by P23.8); `persistExtractedFacts` parallelises the dedup + put path (#26); `HttpMcpTransport` lazy-validates `fetch` instead of throwing in the constructor (#27); the OpenAI-compatible stream emits a generated id when the upstream omits one (#28); `WebFetchTool.execute()` drops the redundant `text.slice(0, parsed.maxBytes)` — the truncated flag is computed against the original length (#41).

### Patch Changes

- Updated dependencies [bcf1501]
- Updated dependencies [f369f53]
- Updated dependencies [e68c610]
- Updated dependencies [71316da]
- Updated dependencies [4b30e7e]
- Updated dependencies [76c5cfc]
- Updated dependencies [f11a82b]
- Updated dependencies [cd89661]
- Updated dependencies [37c19c9]
- Updated dependencies [6cab11f]
- Updated dependencies [17346c7]
  - @lumen/core@0.17.0
