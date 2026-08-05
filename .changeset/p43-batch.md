---
"@lumen/cli": minor
---

P43.a + P43.b + P43.c + P43.d — four P+ slices:

- P43.a — `lumen doctor --section <name>` restricts
  the JSON row set to a single top-level section.
  Human path unchanged.
- P43.b — `lumen tools list --format json` emits
  a JSON array of tool descriptors.
- P43.c — `lumen memory show --verbose --kind <k>`
  restricts the per-kind count to a single kind.
- P43.d — `lumen gateway status --format json` emits
  a structured object on `status`.

Test counts: cli 436 → 438 (+2); monorepo
1935 → 1937 (+2). 0 regressions introduced by
P43 (7 pre-existing failures remain FENCE-OFF).