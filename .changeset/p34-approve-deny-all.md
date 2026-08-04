---
"@lumen/cli": minor
---

P34.5.b — `--approve-all` / `--deny-all` flags (Phase B.5 second slice).

The CLI now ships two flags that pre-resolve the
agent's approver callback. Per P33.B Day3 the
approver is a callback on `AgentConfig`; this
commit threads two pre-resolved callbacks
(`async () => 'allow'` / `async () => 'deny'`)
through `buildAgent` so the operator can opt into
a deterministic posture without writing code.

Surface:

- `apps/cli/src/composition.ts` —
  `CliAgentOptions` gains `approveAll?: boolean` +
  `denyAll?: boolean`. `buildAgent` builds the
  approver as `async () => 'allow'` / `'deny'`
  based on the flag; passes to
  `createAgent({ approver })`.
- `apps/cli/src/commands/run.ts` +
  `commands/chat.tsx` — same flags on
  `RunCommandOptions` / `ChatCommandOptions`.
- `apps/cli/src/index.ts` — registers
  `--approve-all` / `--deny-all` flags on
  `lumen run` + `lumen chat`.

Mutual exclusion is enforced at composition time
(approveAll wins when both are set). TUI real-time
approval prompts remain a future P-ticket.

Test counts: cli 380 unchanged; monorepo 1879
tests / 0 fail / biome clean on touched files.