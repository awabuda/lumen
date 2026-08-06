---
"@lumen/cli": minor
---

P48.d + P48.h — two P+ slices:

- P48.d — `lumen reflect list --list-limit` renames
  the pre-existing `--limit` flag to `--list-limit`
  to match the P44.c `session list --list-limit`
  convention. The function signature now accepts
  `listLimit?`; the pre-P48.d `limit?` field is
  preserved as a fallback.
- P48.h — `lumen session delete <id> --no-load` skips
  the P45.a session + message-history load. The
  JSON path emits `lastAccessMs: null` instead
  of the most-recent message `createdAt`. Useful
  for bulk-delete operations in CI.

Test counts: cli 451 → 453 (+2); monorepo
1950 → 1952 (+2). 0 regressions introduced
(7 pre-existing failures + 1 tools pre-existing
failure remain FENCE-OFF).