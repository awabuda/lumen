---
"@lumen/cli": minor
---

P40.a + P40.b + P40.c + P40.d — four P+ slices:

- P40.a — `lumen team show <path> --format json`
  emits the full team.json as a JSON object.
- P40.b — `lumen checkpoint delete <id> --format json`
  emits a JSON object after a successful delete.
- P40.c — `lumen config show --include-secrets`
  prints the full unredacted config (apiKey /
  Authorization headers included). Default off.
- P40.d — `lumen memory show --verbose` adds a
  per-kind record count to the human + JSON
  output.

Test counts: cli 425 → 428 (+3); monorepo
1924 → 1927 (+3). 0 regressions introduced
by P40 (7 pre-existing failures remain
FENCE-OFF).