# Lumen Pitfalls & Session Learnings

> **维护时间**：2026-06-25 起（与 P19 决策同步创建）。
> **来源**：hermes agent `lumen-agent-framework` skill 的 `references/pitfalls.md`
> (1300+ 行) + P0–P18 复盘 + 2026-06-25 6-question audit。
> **范围**：lumen-side 经验教训。Hermes / OpenClaw / LangChain 等外部
> skill 维护的事实不进 lumen 仓库。
> **看本文件的时机**：开始新 P-ticket / 新包 / 新 provider / 新
> pipeline 之前。

---

## Pre-flight (do this first, every P-pass)

完整 5 步探针，按顺序跑，不要跳：

1. **Re-read `~/workspace/lumen/CLAUDE.md`**（hard rules + P19+ rules）。
2. **Re-read `docs/ARCHITECTURE.md`**（tier diagram，which package
   can import which）。所有 P19+ 任务都必须尊重 tier 隔离。
3. **Skim target package's `base.ts`** — that's the extension seam。
4. **Verify in tree first.** For any "X is missing" or "build X" claim，
   在写代码前先 grep/find 当前 lumen 仓库是否已经有这个能力：
   ```bash
   # For a coverage claim ("is there a real subprocess test?"):
   grep -rn 'spawn' packages/<pkg>/test/
   find packages/<pkg>/test/fixtures -name '*.mjs' -o -name '*.js'

   # For a perf claim ("is there a streaming TTFT bench?"):
   grep -rn 'hrtime\|timeAsync' apps/cli/

   # For an API claim ("does Agent already have .run?"):
   grep -nE 'public (async )?run|public streamRun' packages/core/src/agent/

   # For P19 audit ("is PlanStore wired into Agent.run?"):
   grep -rn 'PlanStore' packages/core/src/
   grep -rn 'LLMPlanner' packages/core/src/
   grep -rn 'RuleBasedReflector\|LLMReflector' packages/core/src/

   # For 4-framework compare ("does Claude Code have plan mode?"):
   grep -rn 'plan.*mode' docs/CLAUDE.md
   ```
   **The footgun is repeated work, not gaps.** 每 P-pass 都会跟
   之前 overlap，P-ticket 列表里缺的 piece **更常见是"已经在树里，
   不在 TASKS.md"**，不是"真的缺"。Concrete example (P17.2)：
   提案"real MCP server integration test"实际上已经被
   `packages/mcp/test/stdio-integration.test.ts` 和
   `http-integration.test.ts` 覆盖（都是 P9 加的，spawn 真
   subprocess fixture server）。提案为新工作会创造第 3 个 fixture
   和 3 个地方要 sync。正确做法是在 P17.2 record 里 document
   existing coverage 然后往下走。
5. **Compare upstream before declaring a new abstraction.** P19+ 任务
   的方案设计必须 fetch 至少 4 个上游框架的 docs：
   ```bash
   python3 ~/.hermes/skills/lumen-agent-framework/scripts/fetch-docs.py \
     https://blog.langchain.com/langchain-v1-0/ \
     https://langchain-ai.github.io/langgraph/concepts/ \
     https://openclaw.ai/blog/ \
     https://docs.claude.com/en/docs/claude-code/overview
   ```
   "你的方案是最佳的吗"是用户的强偏好问题（2026-06-25 确认），
   没有 fetch docs 证据别下结论。

---

## Tooling gotchas (block the day if missed)

### LSP cache lag
Patches 经常出现 stale red squiggles。Always verify with
`pnpm --filter <pkg> typecheck`，not LSP。CLI is the source of truth。

### better-sqlite3 ABI mismatch
**症状**：30-40 tests fail with cryptic module errors.
`TypeError: Cannot read properties of undefined (reading 'dispose')`
or `NODE_MODULE_VERSION` mismatch in `vector-backend.test.ts:setup`。
**修复**（从 repo root 跑）：
```bash
pnpm rebuild  # 根
cd packages/memory && pnpm rebuild better-sqlite3  # 必须在 package cwd
```
两个 rebuild 都必须等 `gyp info ok` 再 re-run tests。**Specific
re-link trigger**: `pnpm exec biome check --write` 改 `package.json`
会 rewrite layout（inline `"files": ["dist"]`、normalize trailing
newline）然后后续 `pnpm install`（甚至 `--offline`）会 re-link
`node_modules/.pnpm/better-sqlite3@*/`，破坏 running Node process
loaded 的 native binding。**任何 biome `--write` 改了 `package.json`
后跟一次 `pnpm install`，rebuild before re-running tests**。

### .bin shims already tracked
`git ls-files | grep -E '/\.bin/' | xargs git rm -r --cached`。
加到 `.gitignore` **不 untrack** 已 tracked 的文件。

### Biome auto-fix
- Run `pnpm exec biome check --write <files>`（glob OK 如
  `packages/core/src/concurrency/`）auto-fix formatting + fixable
  rules (`useTemplate` / `useImportType`).
- After auto-fix, re-run `pnpm typecheck` + `pnpm test` 确认 no
  behavior change。
- Biome **NOT** auto-fix `noNonNullAssertion` — 手动 rewrite
  (guard pattern: `if (x === undefined) return <safe>` 或 restructure
  避免 assertion)。Biome 的 unsafe fix 用 `?.` 加 runtime check 可能
  diverge from intended postcondition — prefer guard pattern。
- biome.json 当前：`noNonNullAssertion: "off"`（P9.1 turn off，因为
  TS narrowing on `.ok` 让 `!` 安全但 biome 看不出来）。

### pnpm exec 不在 root 跑
`pnpm exec vitest` / `pnpm exec biome` / `pnpm exec tsx` 在 lumen
root 跑会 `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` — pnpm 把 bin 放
`node_modules/.pnpm/<pkg>@<ver>/node_modules/.bin/`，`pnpm exec` 找
*当前 cwd* 的 `node_modules`，找不到。
**正确 pattern**：
```bash
# Option A: cd into the package
cd apps/cli && pnpm exec vitest run test/perf

# Option B: --filter
pnpm --filter @lumen/cli exec vitest run test/perf

# Option C: pnpm run（最稳，CI friendly）
pnpm --filter @lumen/cli test
pnpm --filter @lumen/cli bench
pnpm --filter @lumen/cli typecheck
```
biome **是 root devDep**，所以 `pnpm exec biome check .` 从 root 跑
OK。但 `pnpm exec vitest` 不行（vitest 是 app dep）。

### pnpm add 无 --dry-run
`pnpm add` 没有 `--dry-run` flag。**替代**：`pnpm add --lockfile-only`
（lockfile-only 模式不动 `node_modules`，只更新 `pnpm-lock.yaml`）。
**新装包流程**：
1. `pnpm add <pkg> --lockfile-only` 看 lockfile diff
2. `git diff pnpm-lock.yaml | head` 验证
3. `pnpm install` 实际装

### pnpm -r test 噪音
`pnpm -r test` 在 individual failure 时喷
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` 噪音，**summary** 才是要看的：
`... | grep -E "Test Files|Tests"`.

### macOS 沙箱 timeout 命令缺失
macOS 默认 **没有** `timeout` 命令（coreutils 不自带）。`terminal`
tool 内部实现必须用 `AbortController` 模拟 timeout，不要
`child_process.exec('timeout 30 cmd')`。

---

## Code-pattern footguns

### Zod discriminatedUnion + `.strict()`
Tool input schema 用 `z.discriminatedUnion('kind', [...])` + `.strict()`
**强制**：discriminated 字段在 schema、`.strict()` 关掉 unknown
keys 容忍。`safeParse` 失败时返回结构化 `ValidationError`，**不要**
throw generic Error（CLAUDE.md rule #7）。

### `BaseTool.call` 边界 safeParse contract
Tool 内部 `call(input, ctx)` 第一行必须是 `const parsed = this.schema.safeParse(input)`。
失败 throw `ValidationError({ toolName, issues: parsed.error.issues })`。
Tool 框架（Agent.dispatchToolCall）**不再**做 safeParse 兜底。
**反例**：`call(input: any)` 拿 input 直用 → 失去 Zod 类型安全。

### `process.env.X = undefined`
**不要** `process.env.X = undefined` 清 env 变量（会 cast 成 string
"undefined"）。正确：`delete process.env.X`。
**踩坑场景**：test cleanup 想要 reset env 状态。

### `!` non-null assertion 是 P9.1 之后允许的
biome `noNonNullAssertion: off`（P9.1 turn off，因为 TS narrowing
on `.ok` 让 `!` 安全）。**仍 prefer guard pattern** 在不伤害可读性
时（`if (x === undefined) return`）。

### `enum` vs `as const` object
**避免** `enum`（TS 设计上 anti-pattern，运行时多余 object +
non-tree-shakeable）。**用** `as const` object：
```typescript
export const ToolRisk = { safe: 'safe', approvalRequired: 'approval-required', dangerous: 'dangerous' } as const;
export type ToolRisk = (typeof ToolRisk)[keyof typeof ToolRisk];
```

---

## P19 audit footguns (2026-06-25)

P19 audit 暴露的 6 个 "declared-but-not-enforced" / "wrapper-class"
反模式。**这些是 P19 commit 的删除/重写目标，不要在新代码里
重复**：

1. **`BaseSubAgent` / `SingleRunSubAgent`** — `packages/core/src/agent/sub-agent.ts`。
   `SingleRunSubAgent` 是 wrapper class（一个实现继承抽象），
   **P19.3 删除**。换 `SubAgentSpec` interface + `SubAgentMiddleware`。

2. **`LLMPlanner` / `PlanStore`** — `packages/memory/src/`。
   export 完整但 `Agent.run` **不调**。`packages/memory/src/`
   注释明说"planned, not implemented"。**P19.1 wire up**。

3. **`RuleBasedReflector` / `LLMReflector`** — `packages/memory/src/reflector.ts:1-50`。
   双孤儿 — `Agent.run` 不调 `reflect()`。**P19.2 wire up**。

4. **`SkillTrigger`** — `packages/skills/src/trigger.ts:155 行`。
   `KeywordTrigger` / `EmbeddingTrigger` 完整实现但 `Agent.run`
   不调 trigger。**P20.6 渐进式加载**。

5. **`dispatchToolCall` 不查 risk** — `packages/core/src/agent/index.ts:599-640`。
   直接 `tool.call(args, ctx)`，**不查 risk 字段**。ToolRisk 三档
   是 P9.5 / SECURITY.md 4 action item 中的强制项但 enforce 不全。
   **P19.0 middleware 范式 + P19.0.3 dispatchToolCall 改造**。

6. **`write_file` 无 rootDir 检查** — `packages/tools/src/fs/write-file.ts:110 行`。
   `path.resolve(ctx.cwd, userPath)` **不查** `workspaceRoot`。
   **P19.0 + P19.0.x sandbox cross-tool 覆盖**。

---

## Sandbox gotchas

### DefaultSandbox 路径检查
```typescript
const resolved = path.resolve(cwd, userPath);
if (!resolved.startsWith(workspaceRoot + path.sep)) {
  throw new ToolError({ toolName, cause: 'path-traversal' });
}
```
**关键**：trailing `path.sep` 防止 prefix bypass。`/foo/bar` 不应
match `/foo/barbaz`。

### web_fetch 双层 size cap
**两层**：
1. 拒绝 Content-Length > maxBytes 预先（`if (contentLength > maxBytes) throw`）
2. 流式累积（per-byte accumulator）+ `reader.cancel()` when hit max
   （servers lie about Content-Length，单层不靠谱）

### terminal tool policy-violation
Refuse shell-metachar `argv[0]` with **structured result**
`{ ok: false, reason: 'policy-violation' }`，**不要 throw**
（CLAUDE.md rule #7）。

---

## Provider construction patterns

### `OpenAICompatibleProvider` 复用
新 provider (Mistral / DeepSeek / OpenRouter / vLLM) **继承**
`OpenAICompatibleProvider`，override `embed()` / streaming / caching
等差异点。**不要** copy-paste base。

### MistralProvider embed override
`embed()` POST 到 `/v1/embeddings` with `mistral-embed`（Mistral
专用 endpoint，**不是** chat completions 的 `/embeddings` 子路由）。

### ProviderPool `runWithFailover`
`ProviderPool.runWithFailover` 在 `attempts` 数组记录
CircuitOpenError 为 **non-fatal skip**（不 increment breaker
failure count）。`CircuitBreaker` 默认 failureThreshold=5、
cooldownMs=30_000（保守默认值避免 regional outage 期间 lockout）。

---

## L1-AUDIT 摘录

完整 L1 审计在 `docs/L1-AUDIT.md`（88 行）。**3 个最常见 mistake**：

1. **declared-but-not-enforced**：字段 export 但不查（ToolRisk /
   SkillTrigger / PlanStore 全部中招）。
2. **wrapper-class / abstract-base-with-one-impl**：`BaseSubAgent`
   / `SingleRunSubAgent` 是教科书反例。P19+ rule 14：抽象类
   必须 ≥ 2 个非 wrapper 实现。
3. **cross-tier import**：`core` import `memory`（or anything from
   Tier 2 in core）。Build 会 fail 但开发期 IDE 不报警。
   Pre-flight 第一条查 `package.json` 的 dependencies。

---

## 总结

1. **Pre-flight 5 步必须跑**（CLAUDE.md + ARCHITECTURE + base.ts +
   grep verify + 4-framework fetch）。
2. **P19 audit 6 个反模式不要重犯**（declared-but-not-enforced +
   wrapper-class + cross-tier import + sandbox incomplete + 4 子项）。
3. **Tooling gotchas**（better-sqlite3 ABI / biome format 副作用 /
   pnpm exec root / macOS timeout / pnpm add --dry-run 不存在）。
4. **Code-pattern footguns**（Zod discriminated + strict / safeParse
   contract / process.env undefined / enum vs as const）。

Lumen 仓库不依赖 hermes fact_store 启动；本文件是 lumen 自身的
"经验沉淀"，自维护。
