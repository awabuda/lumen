---
"@lumen/cli": minor
"@lumen/core": minor
---

P35.e + P35.f + P36 — three low-risk additive slices:

- P35.e — `lumen apply-patch --format json` emits a
  structured JSON object (dry-run + apply paths
  both honour the flag). Pre-P35.e human output
  is the default.
- P35.f — `lumen session list --format json` emits a
  JSON array of `{ id, title, createdAt, updatedAt }`
  rows. Matches the P34.6 / P35.b `--format` flag
  pattern.
- P36 — bug.md #41 hooks lifecycle upgrade. Adds
  additive `costUsd` + `tokensUsed` optional fields
  to the `run:end` HookEvent. Pre-P36 hooks still
  satisfy the discriminated union; the new fields
  are populated only when the run actually built a
  budget.

Test counts:
- apps/cli 407 → 412 (+5)
- packages/core 667 → 669 (+2)
- monorepo 1906 → 1911 (+5)

End-to-end verified:
- `lumen apply-patch <file> --dry-run --format json`
  → `{ dryRun: true, hunks: 2, summary: [...] }`
- `lumen session list --format json`
  → `[{ id, title, createdAt, updatedAt }, ...]`
- `agent.run(...)` → `run:end` hook →
  `{ costUsd: 0.001, tokensUsed: 42 }`

biome clean on touched files. 0 regressions.