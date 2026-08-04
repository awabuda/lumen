---
"@lumen/cli": minor
---

P34.9.b — `/state` TUI slash command (Phase B backlog slice).

The TUI gains a new slash command that reads three
read-only state surfaces from `built` and emits a
one-line-per-source summary:

- Budget (P23.12): tokens / cost / time
- PlanStore (P34.3): saved plan count
- Memory (P34.1): total records + per-kind breakdown

Lower-overhead alternative to `/cost` + `/plan`
combined. Pure read-only data access — no new
middleware, no new state, no architecture change.

Surface:

- `apps/cli/src/components/slash-commands.ts` —
  `handleStateSlash(built)` returns `{ message }`.
  Same shape as `handlePlanSlash` / `handleTrustSlash`.
- `apps/cli/src/components/Chat.tsx` — registers
  `/state` in the submit branch.
- `apps/cli/test/state-slash.test.ts` — 6 tests
  (empty stubs, budget snapshot, plan count,
  memory by-kind, empty, read failure).

Test counts: cli 385 → 391 (+6); monorepo 1890
tests / 0 fail / biome clean on touched files.