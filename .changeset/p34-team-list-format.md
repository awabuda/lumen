---
"@lumen/cli": minor
---

P34.6 — `lumen team list --format json / --recursive`.

The `lumen team list` sub-command gains two
CI-friendly flags:

- `--format <fmt>` — `'human'` (default) or
  `'json'`. The JSON variant emits a single array
  suitable for diffing against the listing in CI
  pipelines. Empty directory emits `[]`
  (deterministic).
- `--recursive` — recurse into sub-directories
  when scanning for `team.json` / `*.team.json`.
  Pre-P34.6 only the top dir was scanned.

Surface:

- `apps/cli/src/commands/team.ts` —
  `discoverTeamFiles(dir, { recursive? })` is now
  visit-based; the recursive flag gates sub-dir
  descent. The `list` branch builds a structured
  `entries` array first, then renders to either
  human or JSON.
- `TeamCommandOptions` gains `recursive?: boolean`
  + `format?: 'human' | 'json'`.
- `apps/cli/src/index.ts` — `lumen team` sub-command
  gets `--recursive` and `--format <fmt>` flags.

Test counts: cli 380 → 385 (+5); monorepo 1884
tests / 0 fail / biome clean on touched files.