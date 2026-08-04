---
"@lumen/cli": minor
---

P34.3 — `/trust` and `/plan` TUI slash commands (Phase B.3 closure).

The TUI now exposes two new slash commands (no LLM call,
pure data reads from the agent's SqliteStore + the
in-memory PlanStore):

- `/trust` — reads every record from `built.memory`,
  emits a per-kind count + mean / min / max trust
  distribution as a Markdown-flavoured table.
- `/plan`  — reads the live `PlanStore` that
  PlanMiddleware writes into, lists every saved
  plan with its step count.

Surface:

- `apps/cli/src/components/trust-plan-snapshot.ts` —
  new pure-data helpers (`aggregateTrustByKind`,
  `formatTrustSnapshot`, `formatPlanLine`,
  `formatPlanSnapshot`).
- `apps/cli/src/components/slash-commands.ts` —
  `handleTrustSlash(built)` / `handlePlanSlash(built)`.
- `apps/cli/src/components/Chat.tsx` — registers both
  slash commands in the `submit` branch.
- `apps/cli/src/composition.ts` — `BuiltAgent.planStore?`
  field; every PlanMiddleware mount gets a fresh
  PlanStore.

End-to-end verified: the snapshot output reads
cleanly in Ink without breaking lines.

Test counts: cli 362 → 371 (+9); monorepo 1870 tests /
0 fail / biome clean on touched files.