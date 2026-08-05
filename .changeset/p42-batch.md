---
"@lumen/cli": minor
---

P42.a + P42.b + P42.d — three P+ slices:

- P42.a — `lumen init --with-default-profile [name]`
  extends the pre-existing boolean flag with
  commander optional-value syntax. When the flag
  carries an explicit name, that name is spliced
  into the starter config instead of the
  `assistant` default.
- P42.b — `lumen session delete <id> --format json`
  emits a JSON object on delete. Brings `delete`
  to parity with `prune` (P41.c) and `list` (P35.f).
- P42.d — `lumen init --force-all` skips the
  file-existence check for every target file.

P42.c (memory prune by kind) was withdrawn during
the design phase — destructive deletes against the
memory store require a separate design pass
(dry-run + force + permission policy).

Test counts: cli 432 → 436 (+4); monorepo
1931 → 1935 (+4). 0 regressions introduced by
P42 (7 pre-existing failures remain FENCE-OFF).