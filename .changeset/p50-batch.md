---
"@lumen/cli": minor
---

P42.c + P48.e — two P+ slices:

- P42.c — `lumen memory prune [--kind <k>] [--force]`
  adds a new `prune` subcommand to the `memory`
  command. The action is destructive (deletes
  every record whose `kind === pruneKind`, or
  every record if `--kind` is omitted) and
  gated behind `--force`. Without `--force`,
  the action runs in dry-run mode (counts
  would-delete records). The dry-run path
  emits the same shape as the apply path:
  `{ dryRun, removed, kind? }`.
- P48.e — `lumen reflect meta --dry-run` emits
  the pre-apply patch list without writing
  back to the store. Mirrors the
  `plan approve --dry-run` (P46.b) /
  `plan reject --dry-run` (P47.a) pattern.

Test counts: cli 457 → 459 (+2); monorepo
1956 → 1958 (+2). 0 regressions introduced
(7 pre-existing failures + 1 tools pre-existing
failure remain FENCE-OFF).
