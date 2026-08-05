---
"@lumen/cli": minor
---

P38.a + P38.b + P38.c + P38.d — four P+ slices:

- P38.a — `lumen init --with-default-profile` writes
  the uncommented `defaultProfile: assistant` line
  into the starter config so the assistant assembly
  mounts out of the box.
- P38.b — `lumen memory list [--kind <k>]` — new
  subcommand. Reads the SqliteStore and prints every
  record (sorted by createdAt desc, capped at 50).
  `--kind` filters by record kind.
- P38.c — `lumen run --stat` — print the budget
  summary (tokens / cost / time) after the run
  resolves. Mirrors the `/cost` TUI slash.
- P38.d — `lumen checkpoint list --format json` —
  emit a JSON array of { id, iterations, createdAt,
  label? } rows.

Test counts: cli 415 → 420 (+5); monorepo
1914 → 1919 (+5). 0 regressions.