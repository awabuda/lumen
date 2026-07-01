# Lumen Project Rules (for AI agents)

You are working inside the Lumen repository. Read `docs/ARCHITECTURE.md` first.
Everything below assumes you have.

## Hard rules

1. **Never** import from a higher-tier package. The dependency graph in
   ARCHITECTURE.md is enforced by the build, but respect it in your head first.
2. **Never** hardcode model names, file paths, or provider endpoints in
   application code. Use config or DI.
3. **Every** pluggable component must extend a base contract from its package's
   `base.ts`. No duck-typing.
4. **Every** public function takes a Zod schema for its inputs. The Zod schema
   is the single source of truth for type, runtime validation, and JSON Schema
   generation.
5. **Every** public exported symbol has a JSDoc block. We are a public API.
6. **No** `any` in committed code. `unknown` is fine; narrow it.
7. **No** try/catch that swallows. Re-throw or convert to a typed error.
8. **Tests are required** for every new function. Aim for ≥ 80% line coverage
   on the file you changed.
9. **No** new top-level folders. If you need a new package, propose it in your
   PR description and let the maintainer decide.

## P19+ rules (2026-06-25 起，硬性)

10. **Verify in tree first.** 写代码前先 grep/find 当前 lumen 仓库是否已
    经有这个能力。P19+ 的 6-question audit（skill / team / workspace /
    context / failure / security）显示很多"gap"实际上是"已在树里但没
    wire"。`docs/PITFALLS.md` §"Pre-flight" 有完整的 5 步探针。
11. **任何"对 Agent loop 的扩展" = middleware。** 禁止在 AgentConfig 上
    堆 boolean flags（`enablePlan`、`enableReflection`、`enableSkill`）。
    改 Agent loop → 写 `AgentMiddleware`（`packages/core/src/agent/middleware.ts`，
    P19.0）。**例**：`mode: 'plan'`、`reflection: {...}`、`metaReflection:
    {...}` 是 config；`PlanMiddleware` / `InlineReflectionMiddleware` /
    `MetaReflectionMiddleware` 才是实现。
12. **任何"对 Agent state 的语义" = Zod state schema。** 中间件 state
    必须是 Zod discriminated union，append-only，不允许往 root state
    偷加字段。
13. **任何"对 Agent 入口的封装" = `createAgent` factory。** 不要在
    `apps/cli/src/composition.ts` 里手写 `new Agent({...})` 加一堆
    middleware，封装到 `createAgent(config)` 里（`packages/core/src/agent/factory.ts`）。
14. **任何"抽象类只有 1 个实现" = 删除抽象，复用 Agent。** 例：
    `BaseSubAgent` / `SingleRunSubAgent` 在 P19.3 删除。继承链
    至少 ≥ 2 个非 wrapper 实现，否则抽象就是噪音。
15. **helper 优于抽象类。** `BasePlanner` / `BaseReflector` 抽象保留
    为 **interface**，但具体实现（`LLMPlanner` / `RuleBasedReflector`）
    改写为 **function**（function form 可独立 unit-test，不需要 mock
    抽象方法）。`abstract class Foo { abstract bar(): void }` 加 1 个
    实现的 pattern **不允许**。
16. **任何"我能不能用别的抽象"必须先对比 4 框架再问。** LangChain 1.0
    (2025-10-17 GA) / LangGraph 1.0 / OpenClaw / Claude Code / Hermes
    Agent / Cursor 至少选 4 个，fetch 真实 docs 验证（不能凭印象），
    给出 Lumen 与之差异点。完整对比表见 `docs/P19-DESIGN.md` §3。
    "你的方案是最佳的吗"是用户的强偏好问题，必须有 fetch docs 证据
    再下结论。
17. **ToolRisk 三档必须 enforce。** `risk: 'safe' | 'approval-required' |
    'dangerous'` 字段是 P9.5 / SECURITY.md 4 action item 中的强制项。
    `Agent.dispatchToolCall` 必须根据 risk 决定是否 throw / ask user /
    直接执行。`write_file` / `terminal` 等 dangerous 工具必须有
    workspaceRoot 边界检查。
18. **Sandbox 是 cross-tool 的，不是 shell-only 的。** DefaultSandbox
    路径检查必须覆盖 fs 工具（`write_file` / `patch` / `read_file`），
    不是只覆盖 `terminal`。`path.resolve(cwd).startsWith(workspaceRoot
    + path.sep)` 模式（trailing `path.sep` 关键，避免 prefix bypass）。
19. **Reflection / Plan wire-up 才有价值。** `BasePlanner` /
    `LLMPlanner` / `PlanStore` / `RuleBasedReflector` / `LLMReflector`
    都是 P9.5 / P12.5 已 export 但 **Agent.run 不调** 的孤儿代码
    （详见 P19 audit）。P19.1 / P19.2 commit 必须把 middleware 接入
    Agent.run loop，并且至少 3 个 e2e 走通。

## Pre-flight (do this first, every P-pass)

1. Re-read `docs/ARCHITECTURE.md` (tier diagram, which package can import which).
2. Re-read `docs/PITFALLS.md` (lumen-side 经验教训，自 2026-06-25 起维护).
3. Skim the target package's `base.ts` — that's the extension seam.
4. **Verify in tree first.** For any "X is missing" claim:
   ```bash
   grep -rn '<keyword>' packages/<pkg>/src/   # 是否已经 export?
   grep -rn '<keyword>' packages/<pkg>/test/  # 是否有 e2e?
   grep -rn '<keyword>' apps/                 # 是否有 CLI surface?
   ```
   完整 5 步探针在 `docs/PITFALLS.md` §"Pre-flight".
5. **Compare upstream before declaring a new abstraction.** 对 P19+ 任务，
   `scripts/fetch-docs.py https://blog.langchain.com/langchain-v1-0/`
   + LangGraph 1.0 release notes + OpenClaw / Claude Code 官方 blog，
   fetch 真实 URL 后再写方案设计。"我的方案是最佳的吗"是用户会反复
   push 的问题，没有 fetch docs 证据就别下结论。
6. Run `pnpm --filter @lumen/<pkg> typecheck` once *before* writing code
   to confirm the toolchain is clean. After any patch, run
   `pnpm --filter @lumen/<pkg> typecheck` AND
   `pnpm --filter @lumen/<pkg> exec vitest run test/<file>.test.ts`.

## Style

- TypeScript strict + `noUncheckedIndexedAccess`. The `tsconfig.base.json` is
  non-negotiable.
- Use biome for formatting. Two-space indent, single quotes, no semicolons
  (where biome allows), trailing commas.
- Prefer `import type` for type-only imports.
- Prefer `readonly` everywhere it doesn't hurt.
- Prefer `as const` for literal objects.
- Prefer discriminated unions over loose object shapes.

## Architecture style

The user explicitly asked for **inheritable, pluggable, independently runnable**
code. That means:

- **Inheritance > configuration.** When in doubt, define a base class with
  overridable methods, not a config object with boolean flags.
- **Composition over inheritance at the wiring level.** The `Agent` class is
  *composed of* a provider, a tool registry, a memory store, and a hook
  registry. Internally, each of those uses inheritance to expose behavior.
- **Each package has exactly one `base.ts` defining the public extension
  surface.** All other files in that package either implement that surface or
  are utilities used by implementations.
- **No global state.** If you need shared state, pass it through the
  constructor.
- **No singletons.** The closest we get is the registries, and they are
  injected, not imported as globals.
- **P19+ addendum**: 抽象类必须 ≥ 2 个非 wrapper 实现，否则删。Helper
  function 优于抽象类。`AgentConfig` 禁止堆 boolean flags，改 middleware。

## Subagent workflow (for AI orchestrators)

If you are a subagent spawned to implement a specific unit, your contract is:

1. Read `docs/ARCHITECTURE.md` and the relevant `base.ts`.
2. Read `docs/PITFALLS.md` for the target package's known footguns.
3. **Verify in tree first** — grep the package for the keyword before
   proposing "build X". If X is already there, document the existing
   coverage in your PR and stop.
4. For P19+ tickets, **fetch upstream docs** (`scripts/fetch-docs.py`)
   for LangChain / LangGraph / OpenClaw / Claude Code / Hermes / Cursor
   before writing a new abstraction. The 4-framework comparison is
   required.
5. Implement against the base contract. Do not invent new abstractions
   when a middleware + state schema would do (P19+ rule 11-15).
6. Write tests in the same directory as the implementation
   (`foo.ts` → `foo.test.ts`).
7. Run `pnpm --filter <package> test` and `pnpm --filter <package> typecheck`.
8. Report back: paths created, tests passing count, framework
   comparison cited, any deviations from the base contract (and why).

The orchestrator (the user, or another agent) will review your output before
merging.

## Memory and continuity

Lumen 项目自身的"记忆"分两层：
- **会话内**：上一段 commit / 当前 P-ticket / 跨框架对比
  → 见 `docs/P19-DESIGN.md`（P19 完整 design doc）。
- **跨会话**：P-ticket 完成状态 + 关键决策 + 复盘
  → 见 `TASKS.md`（每 P 段有 `### Commits` + `### Push status` +
  `### Backlog`）+ `CHANGELOG.md`。
- **Hermes / OpenClaw / 本地 fact_store**：是外部 agent 维护的元记忆
  （"lumen 项目状态"），不直接进 lumen 仓库。Lumen 仓库不读
  fact_store，也不依赖它启动。
