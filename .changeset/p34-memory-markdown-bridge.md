---
"@lumen/cli": minor
"@lumen/memory": minor
---

P34 — Phase B.1: MEMORY.md / USER.md human-readable memory bridge.

@cmd-p34-bridge ships:
- `packages/memory` markdown-bridge helpers (pure data; no fs):
  `serializeFactsToMarkdown`, `parseMarkdownFacts`,
  `buildMarkdownDocument`, `DEFAULT_TRUST_THRESHOLD = 0.6`.
- `apps/cli/src/memory-markdown-bridge.ts`:
  `createMemoryMarkdownBridge({store, memoryMdPath,
  userMdPath, trustThreshold})` with `syncAfterRun()`,
  `ingestIfNewer()`, `describe()`.
- `apps/cli/src/commands/memory.ts`:
  `lumen memory sync` + `lumen memory show`.
- `gateG_P1_openBoxUsability` flips WARN → OK.
- `gateG_P3_observableLearning` flips WARN → OK.

`lumen doctor --product` with empty ~/.lumen now reports
"All product gates pass."

Test counts: memory 225 → 238 (+13); cli 354 → 358 (+4);
monorepo 1857 tests / 0 fail / biome clean on touched files.