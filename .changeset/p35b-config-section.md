---
"@lumen/cli": minor
---

P35.b — `lumen config show --section <name>`.

The `lumen config show` command gains a `--section <name>`
flag that prints only the named top-level section of the
config (e.g. `model`, `providers`, `mcp`, `agent`).
Unknown names print an empty JSON object and exit 0
(CI-friendly).

Surface:

- `apps/cli/src/commands/config.ts` —
  `ConfigShowOptions` gets `section?: string`. The
  show branch slices the redacted config by
  `opts.section` before `JSON.stringify`.
- `apps/cli/src/index.ts` — `lumen config` registers
  `--section <name>` flag.
- `apps/cli/test/config-section.test.ts` — 3 tests
  (single section, unknown name, full fallback).

Test counts: cli 401 → 404 (+3); monorepo 1903
tests / 0 fail / biome clean on touched files.