---
"@lumen/cli": minor
---

P51.b — `lumen memory show [--verbose] --trust-distribution`
emits an 11-bucket histogram of the records'
`trust` field (0.0 / 0.1 / ... / 1.0) alongside
the per-kind count. The histogram always emits
all 11 keys (zero-count buckets are included
so CI can pipe through `jq` without missing-key
errors).

P51.a (`lumen cost` / `lumen usage` CLI
subcommand — bug.md #71) was withdrawn after
the audit: `lumen run --stat` (P38.c) already
surfaces the budget. P51.c/d/e were withdrawn
as no-op / cross-package design pass items.
P51.b is the only 1-2 commit slice left in
the follow-up queue.

Test counts: cli 459 → 460 (+1); monorepo
1958 → 1959 (+1). 0 regressions introduced
(7 pre-existing failures + 1 tools pre-existing
failure remain FENCE-OFF).
