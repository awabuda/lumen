---
"@lumen/cli": minor
---

P47.a + P47.c + P47.d + P47.e — four P+ slices:

- P47.a — `lumen plan reject --dry-run` does NOT
  apply the rejection. The JSON path emits the
  same shape the apply path would; the human
  path emits `would reject <id>`.
- P47.c — `lumen session show <id> --include-metadata`
  includes the `metadata` field in the JSON output.
  Default off (no surface change).
- P47.d — `lumen memory list --exclude-kind <k>`
  drops records whose kind matches. Inverse of
  `--kind`. Mutually exclusive in the dispatcher.
- P47.e — `lumen plan list --since-ms <ms>` caps
  the plan list to records whose `createdAt >=
  sinceMs`. Mirrors `session list --since-ms`
  (P46.d).

Test counts: cli 447 → 451 (+4); monorepo
1946 → 1950 (+4). 0 regressions introduced
(7 pre-existing failures + 1 tools
pre-existing failure remain FENCE-OFF).