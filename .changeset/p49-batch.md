---
"@lumen/cli": minor
---

P49.a + P49.b + P49.c + P49.d — four P+ slices:

- P49.a — `lumen session show <id> --no-content` drops
  the `content` field from each message in the JSON
  output. Useful for long sessions where CI only
  needs the message skeleton.
- P49.b — `lumen plan list --no-goal` drops the
  `goal` field from each plan in the JSON output.
- P49.c — `lumen reflect list --no-content` drops
  the `content` field from each record in the JSON
  output.
- P49.d — `lumen plan list --no-status` drops the
  `status` field from each plan in the JSON output.

Test counts: cli 453 → 457 (+4); monorepo
1952 → 1956 (+4). 0 regressions introduced
(7 pre-existing failures + 1 tools pre-existing
failure remain FENCE-OFF).