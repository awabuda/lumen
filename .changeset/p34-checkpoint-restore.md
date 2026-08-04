---
"@lumen/cli": minor
---

P34.5 — `lumen checkpoint restore` subcommand (Phase B.5 first slice).

The CLI now ships a restore path that resolves a
saved checkpoint by id, sessionId, or the most
recent in-progress checkpoint across every
session. The restore command does NOT run the
agent — it emits the resolved checkpoint id (or
the full JSON on `--json`) so the caller can
attach it to the next `lumen run --resume-from
<path>:<id>` invocation.

Surface:

- `apps/cli/src/commands/checkpoint.ts` adds
  `checkpointRestoreCommand({id?, sessionId?,
  latest?, json?, store?, file?})`. Same
  `resolveStore` helper as `list/show/delete`.
- `apps/cli/src/index.ts` — new `restore` sub-
  command with `--session`, `--latest`, `--json`
  flags. `--id` is mutually exclusive with
  `--session` / `--latest` and the CLI surfaces a
  clear error when the operator mixes them.
- `BaseCheckpointStore.latestInProgress` (already
  shipped in P32.3) is the underlying primitive.

End-to-end verified:
  `lumen checkpoint restore --help` →
    `--session / --latest / --json` flags documented.

Test counts: cli 374 → 380 (+6); monorepo 1879
tests / 0 fail / biome clean on touched files.