---
"@lumen/cli": minor
---

P46.a + P46.b + P46.c + P46.d — four P+ slices:

- P46.a — `lumen plan show <id> --no-notes` omits
  the `notes` field from both the human and JSON
  output. The flag uses commander negation so the
  pre-existing `--notes <text>` flag (different
  meaning) does not collide.
- P46.b — `lumen plan approve --dry-run` does NOT
  apply the approval. The JSON path emits the
  same shape the apply path would; the human
  path emits `would approve <id>`.
- P46.c — `lumen apply-patch --quiet` suppresses
  the one-line human-path summary. The exit
  code and the JSON path are unaffected.
- P46.d — `lumen session list --since-ms <ms>`
  caps the session list to records whose
  `createdAt >= sinceMs`.

Test counts: cli 443 → 447 (+4); monorepo
1942 → 1946 (+4). 0 regressions introduced
by P46 (the 7 pre-existing failures + 1
tools pre-existing failure remain FENCE-OFF).