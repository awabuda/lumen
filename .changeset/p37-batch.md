---
"@lumen/cli": minor
---

P37.b + P37.c + P37.d — three P+ slices:

- P37.b — `lumen checkpoint show --format json`
  emits the full `AgentCheckpoint` as JSON. Brings
  `show` to parity with `restore --json` (P34.5).
- P37.c — `lumen plan list --format json` emits a
  JSON array of plan rows (id, status, goal, steps,
  createdAt, approvedAt?, rejectedAt?).
- P37.d — `lumen doctor --no-api-key` skips the
  API key presence check (useful for offline CI
  diagnostics). The api-key row is reported as
  WARN with `[SKIP]` marker.

`biome.json` relaxes `performance.noDelete` to off
(env-var reset requires `delete` per Lumen rule 15;
`= undefined` coerces to the string `"undefined"` at
runtime). 2 warnings remain in the test fixture
(intentional, documented inline).

Test counts: cli 412 → 415 (+3); monorepo
1911 → 1914 (+3). 0 regressions.