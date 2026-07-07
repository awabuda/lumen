---
"@lumen/cli": minor
---

P19.6.1 — `lumen plan list/approve/reject` command.

Adds a top-level `lumen plan` command backed by a JSON file at
`~/.lumen/plans.json` (override with `LUMEN_PLANS_PATH` or
`--plans-path`). The CLI hydrates a fresh `PlanStore` from disk on
each invocation so a running `lumen run` process is never mutated
by an operator running `lumen plan approve` in a separate shell.

- `lumen plan list` — print every plan, newest first, with status
  (pending / approved / rejected).
- `lumen plan approve <id> [--notes <text>]` — mark approved.
- `lumen plan reject <id> [--notes <text>]` — mark rejected.

7 new e2e tests in `apps/cli/test/plan.test.ts`. The JSON file is
deliberately plain (not SQLite) because `PlanStore` is in the
core tier and the tier-isolation rule forbids core from importing
`@lumen/memory`.
