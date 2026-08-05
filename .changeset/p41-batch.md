---
"@lumen/cli": minor
---

P41.a + P41.b + P41.c + P41.d — four P+ slices:

- P41.a — `lumen plan approve <id> --format json`
  emits the post-approval Plan shape as JSON.
- P41.b — `lumen plan reject <id> --format json`
  emits the post-rejection Plan shape as JSON.
- P41.c — `lumen session prune --format json`
  emits a JSON object on prune.
- P41.d — `lumen config show --no-redact` is an
  alias for `--include-secrets`. Kept for
  shell-history / script compatibility with the
  pre-P40.c flags.

Test counts: cli 428 → 432 (+4); monorepo
1927 → 1931 (+4). 0 regressions introduced by
P41 (7 pre-existing failures remain FENCE-OFF).