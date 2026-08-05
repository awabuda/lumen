---
"@lumen/cli": minor
---

P34.10 — `lumen team run --dry-run` (CI gate / pre-flight).

`lumen team run` gains a `--dry-run` flag that skips
`buildAgent` / `orchestrateTeam` entirely and just
resolves the team's plan (agents × tasks), emitting
one line per task. Useful as a CI gate: validate the
team.json shape + cross-reference agent/task names
without spending model tokens.

Two output formats:

- human (default): one header + one task per line
- json (--format json): a single JSON object,
  validated structurally

Surface:

- `apps/cli/src/commands/team.ts` —
  `TeamCommandOptions` gets `dryRun?: boolean`. The
  `run` action branch short-circuits when
  `dryRun=true`; no `runParent` required.
- `apps/cli/src/index.ts` — `lumen team` sub-command
  gets `--dry-run` flag. The dispatcher skips
  buildAgent / orchestrateTeam entirely.
- `apps/cli/test/team-dry-run.test.ts` — 4 tests
  (human preview, JSON shape, implicit agents-only
  tasks, parse failure).

Test counts: cli 391 → 395 (+4); monorepo 1894
tests / 0 fail / biome clean on touched files.