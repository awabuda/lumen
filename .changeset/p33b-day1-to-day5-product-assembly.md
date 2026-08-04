---
"@lumen/cli": minor
"@lumen/core": minor
"@lumen/tools": minor
"@lumen/config": minor
---

P33.B Day1-Day5 — ProductAssembly + ToolRisk dispatch gate + FS workspace-root path-guard.

The CLI composition root now resolves a ProductAssembly from `config.product.assembly` (or `defaultProfile` / `LUMEN_PRODUCT=off`) and auto-wires the `assistant` bundle (plan + tool-permission + skill-trigger + reflection). The bare assembly short-circuits the middleware array, giving operators an explicit escape hatch (`--profile bare`).

@lumen/core:
- `AgentConfig.workspaceRoot?` threads the pinned workspace into every `ToolContext` (P33.B Day2 pre-existing).
- `AgentConfig.approver?` callback gates `approval-required` and `dangerous` tool dispatches (P33.B Day3).
- `Agent.dispatchToolCall` reads `tool.risk`; `safe` calls dispatch unchanged, `approval-required` / `dangerous` route through the approver. No approver + dangerous = hard deny; approver throws = treated as deny.

@lumen/tools:
- `packages/tools/src/fs/workspace-guard.ts` ships `resolveSafePath(cwd, workspaceRoot)` with `path + sep` prefix check (P33.B Day2). The five FS tools (`read_file` / `write_file` / `patch` / `list_dir` / `search_files`) wire it into `execute()`.

@lumen/config:
- `LumenConfig.product` slice (strict, optional): `{ assembly?: string }`.
- `BUILTIN_ASSEMBLIES` (`assistant` / `bare`), `resolveProductAssembly`, `profileNameToAssembly` exported.

@lumen/cli:
- `lumen doctor --product` flips G-P4 / G-P6 from FAIL to OK; G-P1 / G-P3 follow in phase B.
- Three new `CliAgentOptions` opt-outs: `enableReflection`, `enablePlan`, `noPermission` (per P19+ rule 11 — opt-out, not enable-boolean).
- `loadCliConfig` switches to `loadConfigWithProfile`.

Test counts: core 656 → 667 (+11); cli 348 → 354 (+6); config 51 unchanged; monorepo 1844 tests / 0 fail / biome clean on touched files.