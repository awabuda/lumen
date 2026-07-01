# P19+ Design Doc: Middleware 范式 + 多 Agent 编排 + 反思 + 安全

> **作者**：lumen 项目内部（hermes agent 辅助 2026-06-25 三轮收敛后定型）。
> **范围**：P19 阶段（middleware 范式 / plan-act / reflection / sub-agent /
> meta-reflection / CLI / bench）所有 ticket 的方案设计 + 跨框架对比
> + 关键决策 + 任务依赖图。
> **配合**：`TASKS.md` 的 `## P19` 段（commit-by-commit 任务清单）+
> `docs/PITFALLS.md`（lumen-side 经验教训）。

---

## 0. 为什么是 P19

P0–P18 解决了"agent 框架能跑起来并能 ship"（13 packages、~963 tests、
v0.11.0 tag、CI、changesets、VitePress docs-site）。P19+ 解决"agent
框架与 LangChain 1.0 / LangGraph 1.0 / Claude Code / OpenClaw /
Hermes 同代对齐，并且补齐在 2026-06-25 六问审计中暴露的全部 gap"。

### 0.1 2026-06-25 六问审计

| # | Question | 现状（2026-06-25） | Gap | P-ticket |
|---|---|---|---|---|
| 1 | lumen skill 渐进式加载怎么做的？ | 没做。`packages/skills/src/trigger.ts:155` 完整但 Agent.run 不调 | 整套 P19.x 反复出现 | P20.6 |
| 2 | agent team 怎么实现？ | 完全没实现。`SingleRunSubAgent` 是 wrapper | 4 模式编排 | P19.3-P19.4 |
| 3 | 多 agent workspace 怎么设计？ | 完全没实现 | editor-bridge 之外的设计 | P19.14 → P20.7 |
| 4 | 上下文/历史/工作调用压缩机制？ | 没做。Budget 三维，无 summarization | summarization middleware | P20.3 |
| 5 | 模型/工具调用失败降级与恢复？ | 部分有。CircuitBreaker + withRetry + runWithFailover。缺 fallback 链 + checkpoint/resume | checkpoint 持久化 | P20.4-P20.5 |
| 6 | 安全审计 — 删文件等需用户授权？ | 缺关键层。ToolRisk 字段有但 Agent.run 不查。DefaultSandbox 只覆盖 shell。SECURITY.md 4 action item 中 2 个未做 | 整套 | P19.0 dispatchToolCall + P19.0 sandbox cross-tool |

P19+ 是把这 6 个 gap **按依赖序**排成可执行 commit 序列，**不是**
单次大重构（每次 P 阶段 1-4 commit，避免大爆炸）。

### 0.2 P19 范式（5 条核心原则，2026-06-25 三轮收敛）

1. **任何"对 Agent loop 的扩展" = middleware**（吸收 LangChain 1.0
   GA 的 `AgentMiddleware` + `beforeModel` / `afterModel` hook +
   `wrapModelCall` 包裹模式）。
2. **任何"对 Agent state 的语义" = state schema**（Zod discriminated，
   append-only，中间件不能往 root state 偷加字段）。
3. **任何"对 Agent 入口的封装" = `createAgent` factory**（不堆
   `new Agent({...})` 加 middleware 散落在 composition root）。
4. **任何"抽象类只有 1 个实现" = 删除抽象，复用 Agent**（删
   `BaseSubAgent` / `SingleRunSubAgent`）。
5. **任何"helper 优于抽象类"**：interface + helper function（可
   独立 unit-test，不需要 mock 抽象方法）。

### 0.3 P19 任务依赖图

```
P19.0 middleware 抽象层（前置）
  ├── P19.1 plan/act mode  ←─────────────────────────────────┐
  ├── P19.2 reflection 三档                                   │
  │     └── P19.5 meta-reflector                              │
  ├── P19.3 sequential + parallel sub-agent  ←────────────────┤
  ├── P19.4 handoff + supervisor sub-agent                    │
  │     └── P19.6 CLI surface (lumen plan/approve/reflect) ───┤
  └── P19.7 bench (orchestration + reflection overhead) ←─────┘
```

P19.0 是所有 P19.x 的前置依赖（middleware 抽象层）。P19.1-P19.4
可并行（互不依赖）。P19.5 依赖 P19.2（meta-reflector 聚合 run-end
reflection）。P19.6 依赖 P19.1 + P19.2（CLI surface 暴露
plan/reflect）。P19.7 依赖 P19.3 + P19.4 + P19.5（bench scenario
覆盖 sub-agent + reflection + meta）。

---

## 1. Middleware 范式 spec

### 1.1 接口定义（P19.0.1）

```typescript
// packages/core/src/agent/middleware.ts

import type { ZodType } from 'zod';
import type { Message, ToolCall, ToolResult } from '../message';

export interface MiddlewareContext {
  readonly runId: string;
  readonly agentName: string;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface BeforeModelHook {
  (messages: readonly Message[], ctx: MiddlewareContext): Promise<readonly Message[]>;
}

export interface AfterModelHook {
  (response: Message, ctx: MiddlewareContext): Promise<Message>;
}

export interface WrapModelCall {
  (call: () => Promise<Message>, ctx: MiddlewareContext): Promise<Message>;
}

export interface WrapToolCall {
  (tool: ToolCall, call: () => Promise<ToolResult>, ctx: MiddlewareContext): Promise<ToolResult>;
}

export interface AgentMiddleware {
  readonly name: string;
  readonly stateSchema?: ZodType;
  readonly beforeModel?: BeforeModelHook;
  readonly afterModel?: AfterModelHook;
  readonly wrapModelCall?: WrapModelCall;
  readonly wrapToolCall?: WrapToolCall;
}
```

### 1.2 关键设计决策

- **`name` 必填**：debug log + error context 用，**禁止**两个
  middleware 同名（runtime 启动时检查，throw `ConfigError`）。
- **state 隔离**：每个 middleware 可以声明 `stateSchema`（Zod），
  Agent.run 把所有 middleware 的 state 合并到 root state 用
  Zod discriminated。**禁止** middleware 直接 mutate root state
  （必须走 schema-defined field）。
- **async parity**：所有 hook 都是 async（`Promise`）。sync impl
  用 `async () => syncResult()` 包裹。
- **error propagation**：middleware throw → 整个 run abort，error
  走 typed error taxonomy（`ConfigError` for setup, `ValidationError`
  for state, `ProviderError` for model call wrapped fail, `ToolError`
  for tool call wrapped fail）。

### 1.3 与 LangChain 1.0 GA 对齐

LangChain 1.0 (2025-10-17 GA) 三大范式：
- `AgentMiddleware` 基类 + `before_model` / `after_model` hook +
  `wrap_model_call` 包裹
- `@hook_config(can_jump_to=['end'])` 装饰器
- `create_agent(model, tools, middleware=[...])` 高阶 API
- `AgentState` typed state schema
- deepagents 默认 middleware stack 固定顺序：TodoList → Filesystem
  → SubAgent → Summarization → PatchToolCalls → HITL

**Lumen P19 vs LangChain 1.0**：
| 维度 | LangChain 1.0 | Lumen P19 |
|---|---|---|
| API 风格 | class extends `AgentMiddleware` | interface + function（**不**强制 class） |
| hook 命名 | `before_model`（snake_case） | `beforeModel`（camelCase 跟 lumen 风格） |
| state schema | `AgentState` 单一 schema | per-middleware `stateSchema` 合并（更灵活） |
| 装饰器 | `@hook_config(can_jump_to=...)` | 不要装饰器（用 function form，Zod runtime check） |
| createAgent | `create_agent(...)` factory | `createAgent(...)` factory（同样） |

Lumen **不**复制 LangChain 的 class 强制（lumen rule #15：helper
function 优于抽象类）。允许 interface + standalone function 两种
实现形式。

---

## 2. P19.1 Plan/Act mode

### 2.1 模式定义

- `mode: 'plan'`：首轮只生成 plan（含 `<plan id="x" />` 标记）
  并停止，user approve 后再 act。
- `mode: 'act'`：直接执行，无 plan 中间步。
- `mode: 'auto'`：第一轮 plan（自动 approve）第二轮 act。

### 2.2 PlanStore schema

```typescript
// packages/core/src/agent/plan.ts
export const PlanStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  toolHint: z.string().optional(),
  status: z.enum(['pending', 'in-progress', 'done', 'skipped']),
}).strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  id: z.string(),
  steps: z.array(PlanStepSchema),
  approvedBy: z.string().optional(),
  approvedAt: z.number().optional(),
}).strict();
export type Plan = z.infer<typeof PlanSchema>;
```

### 2.3 PlanMiddleware 实现要点

```typescript
// packages/core/src/agent/middleware/plan.ts
export const PlanMiddleware: AgentMiddleware = {
  name: 'plan',
  stateSchema: z.object({ plan: PlanSchema.optional() }).strict(),
  beforeModel: async (messages, ctx) => {
    if (ctx.state.mode === 'plan' && !ctx.state.plan) {
      return [...messages, {
        role: 'system',
        content: 'You are in plan mode. Generate a plan with <plan id="x">...</plan> tag, then stop.',
      }];
    }
    return messages;
  },
  afterModel: async (response, ctx) => {
    const planMatch = response.content.match(/<plan id="([^"]+)">([\s\S]*?)<\/plan>/);
    if (planMatch) {
      const plan: Plan = { id: planMatch[1], steps: parseSteps(planMatch[2]) };
      // 设置 state.plan = plan — 通过 MiddlewareContext.state
    }
    return response;
  },
};
```

### 2.4 4-framework 对比

| 框架 | Plan mode 实现 | 与 Lumen P19.1 对齐点 |
|---|---|---|
| **Claude Code** | 内置 `plan` mode（不是 tool），`<plan>...</plan>` 标记，user approve 后切 `act` | Lumen 借鉴 `<plan id="x" />` 标记 |
| **LangChain 1.0 deepagents** | 固定 stack 中无内置 plan（用 TodoList middleware 替代） | Lumen 走自己的 PlanMiddleware |
| **LangGraph 1.0** | 无原生 plan concept（StateGraph 自带 plan-as-graph） | 不直接对齐 |
| **OpenClaw** | 无 plan concept | Lumen 新增 |
| **Hermes** | 散落在 plan skill | Lumen 收纳 |

Lumen 借鉴 Claude Code Plan mode 的 `<plan>` 标记 + LangChain
deepagents 的 middleware 范式。PlanStore schema 是 lumen 自己的
设计（其他框架都没有 typed PlanStore）。

---

## 3. P19.2 Reflection 三档

### 3.1 三档定义

- **inline**：每轮在最后一条 assistant 消息后追加
  `[confidence: 0.X]` token（1 token，0 cost），用 `RuleBasedReflector`
  （基于 message length / tool call 成功率的启发式）。
- **step-level**：每 5 步 1 次 LLM call（用 haiku / 本地 fallback）
  总结历史 + confidence score，写入 state。
- **run-end**：run 结束 1 次 LLM call（haiku）总结完整 run，写入
  `BaseMemoryStore`（带 trust score 起点 0.5）。

### 3.2 配置

```typescript
type ReflectionConfig = {
  inline?: boolean;            // default: true
  stepInterval?: number;        // default: 5
  runEnd?: 'rule' | 'llm' | 'off';  // default: 'rule'
};
```

### 3.3 helper 优于抽象

```typescript
// packages/memory/src/reflector.ts — interface + function
export interface BaseReflector {
  readonly name: string;
}

// 改写为 function form（不是 class extends BaseReflector）
export async function ruleBasedReflect(messages: readonly Message[]): Promise<Reflection> {
  const confidence = computeHeuristicConfidence(messages);
  return { confidence, summary: '...' };
}

export async function llmReflect(
  messages: readonly Message[],
  provider: BaseProvider,
): Promise<Reflection> {
  const summary = await provider.chat([{ role: 'user', content: summarizePrompt(messages) }]);
  return { confidence: extractConfidence(summary), summary: summary.content };
}
```

**Lumen rule #15**：interface + function 比 abstract class + class
继承更可测（function 可独立 unit-test，不需要 mock 抽象方法）。

### 3.4 4-framework 对比

| 框架 | Reflection 实现 | 与 Lumen P19.2 对齐点 |
|---|---|---|
| **LangChain 1.0** | 无原生 reflection | Lumen 新增 |
| **LangGraph 1.0** | 无原生 reflection | Lumen 新增 |
| **OpenClaw** | daily→long-term 蒸馏（cross-session reflection） | Lumen P19.5 meta 借鉴 |
| **Claude Code** | 无 reflection（visible 思考） | Lumen 新增 |
| **Hermes** | fact_store trust score（per-fact reflection） | Lumen P19.5 cross-run 借鉴 |

Lumen 三档 reflection 是 **新设计**。inline 0-cost 启发式是
lumen 自己想的；step-level + run-end 借鉴 OpenClaw daily distillation
的概念但实现完全不同（OpenClaw 是 cross-session，Lumen 是
cross-step + cross-run）。

---

## 4. P19.3-P19.4 Sub-agent 编排

### 4.1 删 `BaseSubAgent` / `SingleRunSubAgent`

**P19.3.1 强制删除**。当前实现是 wrapper class（一个实现继承抽象，
违反 P19 rule #4）。换成 `SubAgentSpec` interface + `SubAgentMiddleware`。

### 4.2 `SubAgentSpec` interface

```typescript
// packages/core/src/agent/sub-agent.ts
export const SubAgentSpecSchema = z.object({
  name: z.string(),
  description: z.string(),
  systemPrompt: z.string(),
  tools: z.array(z.string()),  // tool name 列表
  model: z.string().optional(),  // optional 用 ProviderPool 路由
}).strict();
export type SubAgentSpec = z.infer<typeof SubAgentSpecSchema>;
```

deepagents 风格（dict + name + description + system_prompt + tools
+ model）。**不**继承 Agent，**不** extends BaseAgent，**不** is-a
relationship。Sub-agent 通过 SubAgentMiddleware + `task` 工具
召唤。

### 4.3 4 模式编排

| 模式 | 实现 | 关键决策 |
|---|---|---|
| SequentialSubAgent | extends BaseAgent（独立实现，~150-200 行） | 串行 N 个 sub-agent |
| ParallelSubAgent | extends BaseAgent（~150-200 行） | Promise.all 并行，结果合并 |
| HandoffSubAgent | handoff tool call protocol | OpenAI Swarm 风格 |
| SupervisorSubAgent | supervisor step 后评估 continue/redo/abort | 用 1 LLM call（haiku）决策 |

**为什么 4 模式独立实现 extends BaseAgent 而不是 middleware？**
deepagents 哲学："sub-agent 是独立 agent"。middleware 范式适合
"hook into single agent loop"，不适合"编排 N 个 agent"。
Lumen P19 rule #3：任何"对 Agent 入口的封装" = factory。sub-agent
编排是 agent 入口的封装（不是 hook），所以走独立 class + factory。

### 4.4 4-framework 对比

| 框架 | Sub-agent 实现 | 与 Lumen P19.3-19.4 对齐点 |
|---|---|---|
| **Claude Code** | Task tool（`general-purpose` agent + `statusline-setup` agent 等）+ 并行 delegation | Lumen 借鉴 Task 工具模式 |
| **LangChain 1.0 deepagents** | SubAgentMiddleware + `task` tool（`{ subagent, prompt }`）+ `general_purpose_subagent.enabled` | Lumen **直接对齐** deepagents sub-agent 范式 |
| **LangGraph 1.0** | prebuilt Supervisor + Command primitive | Lumen P19.4 supervisor 借鉴 |
| **OpenAI Swarm** | Handoff protocol（`{ handoff: { to, reason } }` tool call） | Lumen P19.4 handoff 借鉴 |
| **OpenClaw** | group-chat 礼仪（多 agent 在群里互发消息） | Lumen 不直接借鉴（chat-only 概念） |
| **Hermes** | delegate_task + session_search | Lumen P20.7 借鉴 |

Lumen 是 **4 模式并行**（Sequential / Parallel / Handoff /
Supervisor），其他框架都只覆盖其中 1-2 个。Lumen 的全模式是
lumen 自己的设计。

---

## 5. P19.5 MetaReflector

### 5.1 触发

每 10 run 触发一次（默认）。`AgentConfig.metaReflection?: { interval?: number, strategy: 'clustering' }`。

### 5.2 实现

```typescript
// packages/memory/src/meta-reflector.ts
export interface BaseMetaReflector {
  readonly name: string;
}

export async function clusteringMetaReflect(
  reflections: readonly Reflection[],
  provider: BaseProvider,
): Promise<MetaReflection> {
  // 1. 按 similarity 聚类（cosine similarity of reflection.summary）
  // 2. 提取 clusters
  // 3. 用 LLM 总结 clusters → 1 个 cross-run reflection
  // 4. 返回 clusters + cross-run summary
}
```

### 5.3 cross-run trust 调整

```typescript
export async function adjustTrustFromMeta(
  meta: MetaReflection,
  store: BaseMemoryStore,
): Promise<void> {
  for (const fact of await store.getAllFacts()) {
    if (meta.clusters.some(c => c.factIds.includes(fact.id))) {
      const delta = computeTrustDelta(fact, meta);
      await store.updateTrust(fact.id, fact.trust + delta);  // 不删 fact
    }
  }
}
```

**关键决策**：cross-run reflection 写回 `BaseMemoryStore` 的 fact
是 **trust delta**（不复写原 fact，只调整 trust score）。借鉴
Hermes fact_store 的 holographic trust 模式。

### 5.4 4-framework 对比

| 框架 | Meta/cross-run reflection | 与 Lumen P19.5 对齐点 |
|---|---|---|
| **LangChain 1.0** | 无 | Lumen 新增 |
| **OpenClaw** | daily→long-term 蒸馏（cross-session memory upgrade） | Lumen 借鉴但实现不同 |
| **Hermes** | fact_store trust score（per-fact, holographic） | Lumen 借鉴 trust delta 模式 |
| **LangGraph 1.0** | 无 | Lumen 新增 |

Lumen P19.5 是 **新设计**（meta reflection + trust delta）。其他
框架都没有 typed meta reflection。

---

## 6. P19.6 CLI surface

### 6.1 三个新子命令

```bash
lumen plan list                # 列出 PlanStore 中所有 active plan
lumen plan approve <planId>    # 标记 plan.approvedBy
lumen plan reject <planId>     # 删除 plan
lumen reflect run <runId>      # 手动触发 run-end reflection
lumen reflect meta             # 手动触发 meta reflection
```

### 6.2 关键决策

- `lumen plan` 复用 PlanStore（不重新实现）
- `lumen reflect` 复用 BaseReflector helper（不重新实现）
- 4 个 integration test 覆盖：list / approve-and-continue /
  reflect-run / reflect-meta

### 6.3 4-framework 对比

Lumen CLI surface 是 lumen 自己的设计（`apps/cli` 包）。其他
框架的 CLI：
- LangChain：`langchain` CLI（langchain-template，langchain serve）
- LangGraph：`langgraph` CLI（dev / build / deploy）
- Claude Code：`claude` CLI（chat / code / plan）
- OpenClaw：`openclaw` CLI（chat / agent / skill）
- Hermes：`hermes` CLI（chat / config / skill / cron）

Lumen P19.6 的 `lumen plan` / `lumen reflect` 是 lumen 独有的
CLI surface（其他框架没有 typed plan/reflection CLI）。

---

## 7. P19.7 Bench

### 7.1 5 个新 scenario

- `05-sequential-subagent.test.ts` — N=3 sequential sub-agent
  wall-clock（baseline 1x single agent）
- `06-parallel-subagent.test.ts` — N=3 parallel sub-agent
  wall-clock（vs sequential）
- `07-reflection-overhead.test.ts` — inline vs step-level vs
  run-end 三档 reflection 的 token 成本对比
- `08-meta-reflection.test.ts` — 10-run meta reflection 触发延迟
- quality 第二 axis（每 scenario 加 `quality: { planCoverage,
  reflectionConfidence, subagentCoordination }`，rule-based 评分
  0-1）

### 7.2 LangSmith-style quality

借鉴 LangSmith 的 dataset + scoring 概念但 **不开 SaaS**（lumen
self-host）。Quality score 用 rule-based 评分（plan coverage =
已 approved 步骤 / 总步骤；reflection confidence = last reflection
confidence；subagent coordination = success rate）。

### 7.3 4-framework 对比

| 框架 | Bench 工具 | 与 Lumen P19.7 对齐点 |
|---|---|---|
| **LangSmith** | dataset + scoring + trace | Lumen 借鉴 scoring，不开 SaaS |
| **LangGraph** | checkpointer replay（回放测试） | Lumen P20.4 借鉴 |
| **Claude Code** | 无公开 bench | Lumen 新增 |
| **OpenClaw** | 无公开 bench | Lumen 新增 |
| **Hermes** | session_search FTS5 query time | 不直接对齐 |

Lumen P19.7 的 perf bench 已经有 P17.3 / P18.2 / P18.3 基础。
P19.7 加 4 个 orchestration + reflection scenario + quality
第二 axis。

---

## 8. 关键决策总结（P19 整体）

### 8.1 范式

1. **middleware > config**：避免在 AgentConfig 上堆 boolean flags
2. **helper function > abstract class**：`BasePlanner` / `BaseReflector`
   抽象保留为 interface + helper
3. **删 wrapper 抽象**：`BaseSubAgent` / `SingleRunSubAgent` 删除
4. **tier 隔离通过 DI**：core → memory 不 import，planner/reflector
   通过 AgentConfig 注入

### 8.2 实现

5. **sequential/parallel/handoff/supervisor 4 模式独立实现 extends
   BaseAgent**（不合并 middleware）
6. **plan/act/auto 三 mode** + `<plan id="x" />` 标记（借鉴 Claude
   Code）
7. **reflection 三档**：inline = 1 token / step-level = 5 步 / run-end
   = 1 run
8. **MetaReflector 触发频次 = 10 run**（默认）
9. **cross-run trust delta**（不复写 fact，只调 trust score，借鉴
   Hermes fact_store）
10. **bench 借鉴 LangSmith**：每 scenario 加 quality 第二 axis

### 8.3 工具

11. **ToolRisk 三档必须 enforce**（Agent.dispatchToolCall 改造）
12. **Sandbox cross-tool 覆盖**（write_file / patch / read_file +
    terminal）
13. **P19 4-framework 对比必做**（fetch 真实 docs，不能凭印象）

---

## 9. 总预算

- 7 P-ticket × 平均 3-4 commit = **~24 commit**
- 19 e2e + integration test
- +3000~+4000 行代码（middleware + 4 sub-agent + 3 reflection +
  CLI + bench）
- +2000~+3000 行测试
- +800 行 docs（本文件 + VitePress 同步）

---

## 10. 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| middleware 改 Agent.run loop 破坏现有 P0-P18 行为 | P19.0.4 单元测试覆盖 composition order / 兼容旧 `hooks` 字段 |
| PlanStore 跨 tier（core→memory） | DI 注入：AgentConfig.planner? 而非 import |
| Sub-agent 编排 OOM / 死锁 | hard assert `max < 60s` 沿用 P18.3；supervisor 决策 abort 路径 |
| Reflection overhead 拖慢 perf | inline 0-cost；step-level 5 步间隔；run-end 1 次 |
| MetaReflector trust delta 误调 | 单元测试覆盖 trust delta 边界（不超 1.0，不低于 0.0） |
| 4-framework 对比 fetch 失败 | `scripts/fetch-docs.py` 已有 fallback（hydration shell 检测） |

---

## 11. 引用

- LangChain 1.0 GA (2025-10-17) release notes — `https://blog.langchain.com/langchain-v1-0/`
- LangGraph 1.0 release notes — `https://github.com/langchain-ai/langgraph/releases`
- OpenClaw blog — `https://openclaw.ai/blog/`
- Claude Code docs — `https://docs.claude.com/en/docs/claude-code/overview`
- Hermes agent skill — `~/.hermes/skills/lumen-agent-framework/`
- Lumen P0-P18 记录 — `TASKS.md` + `CHANGELOG.md`
- Lumen pitfalls — `docs/PITFALLS.md`
- Lumen 6-question audit（2026-06-25）—  见
  `~/.hermes/skills/lumen-agent-framework/references/p19-6question-audit.md`
  (Lumen 仓库不依赖 hermes skill 启动；此 reference 留作 history)

---

**Lumen P19+ 不依赖 hermes / OpenClaw / LangChain SaaS 启动**。本
design doc 是 lumen 自身的设计资产，自维护。
