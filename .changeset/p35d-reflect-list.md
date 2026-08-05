---
"@lumen/cli": minor
---

P35.d — `lumen reflect list` (introspection).

`lumen reflect` gains a third subcommand: `list`. It
reads the SqliteStore and prints every `kind:
'reflection'` record. The command is read-only.

Two output formats:

- `human` (default): one header + one line per record
- `json`:           a single JSON array

Records are sorted by `createdAt` (newest first).
Limit defaults to 50 records.

Surface:

- `apps/cli/src/commands/reflect.ts` — `ReflectListOptions`
  + `reflectListCommand`.
- `apps/cli/src/index.ts` — `lumen reflect` registers
  `list` sub-command + `--format` / `--limit` flags.
- `apps/cli/test/reflect-list.test.ts` — 3 tests.

Test counts: cli 404 → 407 (+3); monorepo 1906
tests / 0 fail / biome clean on touched files.