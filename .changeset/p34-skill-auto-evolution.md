---
"@lumen/cli": minor
"@lumen/skills": minor
---

P34.2 — Skill auto-evolution (Phase B.2 closure).

@cmd-p34-bridge:
- `@lumen/skills` barrel now exports `BaseEvolver` /
  `HeuristicEvolver` / `LLMEvolver` / `EvolutionResult`
  / `EvolverChatMessage`.
- `apps/cli/src/skill-evolution-bridge.ts` exports
  `createSkillEvolutionBridge({ skillsDir?, evolver? })`
  with a single `afterRunHook(result)` method.
- `apps/cli/src/composition.ts` mounts the bridge
  as an `afterRun` middleware when the resolved
  assembly bundles `skillEvolution: 'trajectory'`
  AND the caller did not pass `noSkillEvolve`.
- `BUILTIN_ASSEMBLIES.assistant.skillEvolution`
  flips from `'reserved'` (P33.B Day1 placeholder)
  to `'trajectory'` (active evolver).
- New `CliAgentOptions.noSkillEvolve?: boolean`
  opt-out flag.

End-to-end: a 3-tool-call run produces a new
`SKILL.md` under the skills directory via the
HeuristicEvolver template. LLM-backed evolution
is exported but stays opt-in (future P-ticket).

Test counts: cli 358 → 362 (+4); monorepo 1861 tests /
0 fail / biome clean on touched files.