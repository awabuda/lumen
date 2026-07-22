# Lumen Agent 代码审查问题报告

> 审查日期: 2026-07-15
> 审查范围: `packages/core/src/agent/` 核心模块及相关中间件
> 与 OpenClaw / Claude Code 功能对比
>
> **状态（2026-07-22）**：73 项中 55 项已 ship（按 4-tag verdict =
> CORRECT + PARTIAL 范畴，全 commit landing），14 项保留为
> P24+ 提案（FEATURE_GAP，按 user preference rule 不入 P23
> sweep）。详见 TASKS.md 的 P23 / P23.11 段 + 提交日志
> `git log --grep="P23"`。
> 
> **状态（2026-07-22 update）**：P23.12 batch 增 ship 4 项 (#64 #69 #70
> #71 — DuckDuckGo HTML tokenizer, /loop /cost /init slash
> commands + ProjectAnalyzer)，于是 bug.md 中真 ship **55+4=59
> 项**（含 silently-shipped 同 surface 的 #3 #16 #17 #18 #34
> #56 #57 #61 #65 #66 共 9 项）。剩余 14 项为 FEATURE_GAP (= 不
> 入 P23 sweep，按 user rule)。最新 commit hash:
> `git log --grep="P23" --no-merges`。

---

## 目录

- [一、P0 严重缺陷 (Critical)](#一p0-严重缺陷-critical)
- [二、P1 重要问题 (Major)](#二p1-重要问题-major)
- [三、P2 中等问题 (Moderate)](#三p2-中等问题-moderate)
- [四、P3 次要问题 (Minor)](#四p3-次要问题-minor)
- [五、架构重构建议](#五架构重构建议)
- [六、总结](#六总结)

---

## 一、P0 严重缺陷 (Critical)

这些问题直接影响生产环境的安全性和核心功能可用性，必须立即修复。

### 1. `streamRun()` 完全绕过中间件系统

**位置**: `packages/core/src/agent/index.ts:520-761`

**问题描述**: `streamRun()` 方法是 CLI/TUI 使用的主要入口，但它完全绕过了所有中间件系统：
- 直接调用 `this.provider.stream()` 而不是 `callProviderWithMiddleware()`
- 直接调用 `this.dispatchToolCall()` 而不是 `callToolWithMiddleware()`
- 没有调用 `applyBeforeModel()`、`applyAfterModel()`、`applyAfterRun()`

**影响**:
- **安全风险**: 权限策略（`tool-permission`）、自动模式分类器（`tool-permission-auto`）、人工审核中断（`interrupt`）全部失效
- **功能缺失**: 计划模式（`plan`）、反思（`reflection`）、技能触发（`skill-trigger`）、上下文压缩（`context-compression`）全部跳过
- **不一致行为**: `run()` 和 `streamRun()` 行为完全不同

**代码证据**:
```typescript
// streamRun() 中直接调用 provider.stream()，没有经过任何 middleware
for await (const ev of this.provider.stream(
  { messages, model: this.model },
  signal ? { signal } : undefined,
)) { ... }

// 直接调用 dispatchToolCall，绕过 wrapToolCall 中间件链
const result = await this.dispatchToolCall(call, signal)
```

**修复建议**: 重构 `streamRun()` 使其复用中间件链，或提取公共执行逻辑。

---

### 2. 子代理完全绕过中间件链

**位置**: `packages/core/src/agent/sub-agent.ts:91-110`

**问题描述**: `buildAgent()` 使用 `new Agent(...)` 而不是 `createAgent(...)` 来构建子代理，导致父代理配置的所有中间件（权限策略、中断、自动模式等）对子代理完全无效。一个配置了严格权限策略的父代理会生成一个完全不受限制的子代理。

**代码证据**:
```typescript
const buildAgent = (
  parent: AgentConfig,
  goal: string,
  options: {...},
): Agent => {
  // 直接 new Agent，没有通过 createAgent 注入 middleware
  return new Agent({
    ...parent,
    tools,
    model: options.model ?? parent.model,
    systemPrompt: options.systemPrompt ?? SUB_AGENT_SYSTEM_PROMPT(goal),
  })
}
```

**修复建议**: 使用 `createAgent()` 构建子代理，并继承父代理的中间件配置。

---

## 二、P1 重要问题 (Major)

这些问题影响系统的正确性、安全性或核心功能。

### 3. `SubAgentMiddlewareOptions.parent` 类型不包含 `middleware`

**位置**: `packages/core/src/agent/middleware/sub-agent.ts:26-32`

**问题描述**: `SubAgentMiddlewareOptions.parent` 类型只包含 `provider`、`tools`、`model`、`cwd`，没有 `middleware` 字段。即使修复了 `buildAgent` 使用 `createAgent`，子代理也无法继承父代理的中间件配置，因为 parent 配置中根本不携带中间件信息。

**代码证据**:
```typescript
readonly parent: {
  readonly provider: BaseProvider
  readonly tools: import('../../tools/index.js').ToolRegistry
  readonly model?: string
  readonly cwd?: string
  // 缺少 middleware！
}
```

**影响**: 通过 `task` 工具调用的子代理不受父代理的权限策略、中断检查等中间件约束，是问题 #2 的根因之一。

**修复建议**: 在 `parent` 类型中添加 `readonly middleware?: ReadonlyArray<AgentMiddleware>`，并在 `createSubAgentFromSpec` 中传递给 `createAgent`。

---

### 4. 多个中间件使用闭包变量而非状态管理机制

**位置**: `packages/core/src/agent/middleware/interrupt.ts:118`、`tool-permission.ts:275`、`auto-mode.ts:255`

**问题描述**: `createInterruptMiddleware`、`createToolPermissionMiddleware` 和 `createAutoModeMiddleware` 都声明了 `stateSchema` 和 `initialState`，但实际使用闭包变量 `decisions` 来记录决策历史。中间件状态从未被更新，导致状态快照始终为初始值。

**代码证据**（以 ToolPermissionMiddleware 为例）:
```typescript
const decisions: ToolPermissionDecisionRecord[] = []  // 闭包变量

return {
  name: 'tool-permission',
  stateSchema: z.object({ decisions: z.array(...) }),
  initialState: { decisions: [] },  // 声明了状态但从未通过 set() 更新
  wrapToolCall: async (toolCall, defaultCall) => {
    decisions.push(record)  // 写入闭包变量，而非中间件状态
    ...
  },
}
```

**影响**:
- `MiddlewareStateView` 获取的决策历史始终为空数组
- 如果中间件实例在多个 run 之间被复用，闭包变量会累积历史数据
- 状态审计和快照功能形同虚设

**修复建议**: 使用 `MiddlewareStateView.set()` 机制更新状态，或移除未使用的 `stateSchema`/`initialState` 声明。

---

### 5. 中间件状态管理违反设计规范

**位置**: `packages/core/src/agent/middleware/plan.ts`、`packages/core/src/agent/middleware/reflection.ts`

**问题描述**: 中间件规范（`middleware.ts`）明确要求状态通过 `set()` 回调更新（append-only），但实际实现直接修改状态对象。

**PlanMiddleware**:
```typescript
const stateFrom = (state: unknown): PlanMiddlewareState => {
  PlanMiddlewareStateSchema.parse(state)
  return state as PlanMiddlewareState  // 类型转换后直接修改
}

beforeModel: async (messages, ctx) => {
  const state = stateFrom(ctx.state.plan)
  state.goal = goal      // 直接修改，违反 append-only
  state.plan = plan      // 直接修改
  state.phase = 'acting' // 直接修改
}
```

**ReflectionMiddleware**:
```typescript
afterModel: (message, ctx) => {
  const state = stateFrom(ctx.state.reflection)
  state.stepCount += 1   // 直接修改
  state.last = reflection // 直接修改
}
```

**影响**:
- 违反了 `MiddlewareStateView<TState>` 的设计意图
- 无法进行状态变更的审计和验证
- 多个中间件可能意外修改彼此的状态

**修复建议**: 实现 `MiddlewareStateView.set()` 机制，强制中间件通过该接口更新状态。

---

### 6. ReflectionMiddleware 的启发式算法几乎无效

**位置**: `packages/core/src/agent/middleware/reflection.ts:84-97`

**问题描述**: `afterModel` 钩子中，反思算法只接收单个消息 `[message]`，而不是完整的对话历史，导致基于消息计数的置信度计算完全不准确。

**代码证据**:
```typescript
afterModel: (message, ctx) => {
  const state = stateFrom(ctx.state.reflection)
  state.stepCount += 1
  const messages = [message]  // 只有当前消息！
  const reflection = ruleBasedReflectMessages(messages)
  ...
}
```

**影响**:
- `assistantCount` 始终为 1
- `toolCount` 始终为 0
- `errorSignals` 只能检测当前消息中的错误

**修复建议**: 传递完整的消息历史给反思算法。

---

### 7. `ToolContext.sessionId` 始终为空字符串

**位置**: `packages/core/src/agent/index.ts:948`

**问题描述**: 在 `dispatchToolCall()` 中，传递给工具的 `sessionId` 始终是空字符串。

**代码证据**:
```typescript
const output = await tool.call(call.arguments, {
  cwd: this.cwd,
  signal: signal ?? new AbortController().signal,
  sessionId: '',  // 始终为空！
  log: {...},
})
```

**影响**:
- 工具无法关联会话上下文
- 多用户场景下无法进行会话隔离
- 审计日志缺失关键的会话标识

**修复建议**: 传递真实的 sessionId。

---

### 8. `ParallelSubAgent.stream()` 不是真正的流式输出

**位置**: `packages/core/src/agent/sub-agent-orchestration.ts:168-183`

**问题描述**: `createParallelSubAgent` 的 `stream()` 方法先等待所有子代理通过 `Promise.allSettled` 全部完成，然后才逐个 yield 结果。这不是真正的流式输出——用户无法在某个子代理完成时立即看到结果。

**代码证据**:
```typescript
async *stream(): AsyncGenerator<SubAgentTaskResult> {
  // 先等待所有任务完成
  const settled = await withTimeout(
    Promise.allSettled(
      parsed.tasks.map((task) => buildRunner(...).run()),
    ),
    timeoutMs,
  )
  // 然后才逐个 yield
  for (let i = 0; i < parsed.tasks.length; i += 1) {
    yield entry
  }
}
```

**影响**: 并行子代理场景下，先完成的子代理结果需要等待最慢的子代理完成后才能展示，用户体验差。

**修复建议**: 使用 `Promise.race` 或 `AsyncQueue` 模式，在子代理完成时立即 yield。

---

### 9. 缺少真实的浏览器自动化（Browser Tool）

**参考实现**: OpenClaw 内置 Chromium 浏览器，Claude Code 内置 browser-use  
**lumen 现状**: `WebFetchTool` 仅使用 HTTP fetch + DuckDuckGo 搜索，无法处理 JavaScript 渲染、登录态、表单交互

**影响**:
- 无法访问 SPA（Single Page Application）站点（Notion、Google Docs、大多数 SaaS）
- 无法处理 OAuth 登录、Cookie 维持
- 无法执行点击、填表、截图等交互
- 只能抓取静态 HTML，对于现代 Web 失败率极高

**修复建议**: 集成 `playwright` 或 `puppeteer` 作为内置工具，提供完整的 browser-use 能力。

---

### 10. 缺少 Computer Use（桌面控制）能力

**参考实现**: OpenClaw Codex Computer Use、Claude Cowork  
**lumen 现状**: 完全缺失，无屏幕控制、鼠标键盘模拟、桌面应用交互能力

**影响**:
- 无法跨应用执行任务（如打开桌面软件、操作文件管理器）
- 无法处理仅提供 GUI 而无 API 的应用
- 任务边界被限制在 CLI 工具能触及的范围内

**修复建议**: 实现 Computer Use provider，封装 `nut.js` 或类似库提供跨平台桌面控制。

---

## 三、P2 中等问题 (Moderate)

这些问题影响系统的可维护性、性能或部分功能的正确性。

### 11. `run()` 和 `streamRun()` 大量重复代码

**位置**: `packages/core/src/agent/index.ts:268-498` vs `520-761`

**问题描述**: 两个方法共享约90%的逻辑（初始化、信号检查、内存持久化、迭代循环控制、工具调用分发、Checkpoint 保存、错误处理），导致：
- 维护成本高：修复一个bug需要在两个地方同时修改
- 行为不一致：`run()` 使用中间件，`streamRun()` 不使用
- 测试负担：需要为两条路径编写测试

**修复建议**: 提取公共的循环逻辑到私有方法，让 `run()` 和 `streamRun()` 只处理同步/异步差异。

---

### 12. Checkpoint 保存失败被静默忽略

**位置**: `packages/core/src/agent/index.ts:237-240`

**问题描述**: `saveCheckpointBestEffort()` 使用空的 catch 块，所有保存失败都被静默忽略。

**代码证据**:
```typescript
try {
  // ... 保存 checkpoint
} catch {
  // Checkpoint persistence is best-effort. A storage outage must never
  // replace the agent result or the original run error.
}
```

**影响**:
- 存储故障时没有日志记录
- 用户无法知道 checkpoint 是否成功保存
- 调试困难：无法区分"保存失败"和"从未尝试保存"

**修复建议**: 添加日志记录，至少记录警告级别日志。

---

### 13. Budget 只跟踪 Token，Cost/Time 从未接入

**位置**: `packages/core/src/budget/index.ts`、`packages/core/src/agent/index.ts`

**问题描述**: Budget 类支持三个维度（tokens、cost、time），但实际使用中只有 `addTokens()` 在 `run()` 中被调用，`addCost()` 和时间限制从未被使用。

**代码证据**:
```typescript
// run() 中只调用 addTokens
if (responseMessage.usage) {
  budget.addTokens(responseMessage.usage.totalTokens)
}
// addCost() 和 timeMs 检查完全缺失
```

**修复建议**: 接入 cost 和 time 的跟踪和检查逻辑。

---

### 14. `ProviderPool.stream()` 的 failover 逻辑不完整

**位置**: `packages/core/src/agent/pool.ts:386-426`

**问题描述**: 流式调用的 failover 只在第一个事件是错误时才触发。一旦输出了第一个事件就 commit 到该 provider，后续流中的错误（如网络中断、部分响应失败）不会触发 failover，直接导致整个请求失败。

**代码证据**:
```typescript
// 只有第一个事件失败才重试
try {
  const head = await iter.next()
  if (head.done === true) { ... continue }
  firstEvent = head.value
} catch (err) {
  lastError = err
  continue  // 只有这里会 failover
}
// 一旦输出了第一个事件，就不再 failover
if (firstEvent) yield firstEvent
for await (const ev of iter) yield ev  // 这里出错不会重试
return
```

**影响**: 流式响应过程中的网络错误会导致整个请求失败且无法恢复。对于长时间流式对话（如代码生成），中途失败的概率不可忽视。

**修复建议**: 考虑在 `for await` 循环中添加错误处理，或在文档中明确说明流式调用不支持中途 failover 的限制。

---

### 15. `SqliteStore` 向量搜索维度硬编码为 1536

**位置**: `packages/memory/src/sqlite-store.ts:151-162`

**问题描述**: `buildVectorBackend` 方法将向量维度硬编码为 1536（对应 OpenAI text-embedding-3-small），不支持其他维度的嵌入模型。

**代码证据**:
```typescript
private buildVectorBackend(): BaseVectorBackend {
  const dimensions = 1536  // 硬编码！
  const loaded = SqliteVecBackend.tryLoad(this.db)
  if (loaded) {
    const backend = new SqliteVecBackend(this.db, dimensions)
    backend.init()
    return backend
  }
  return new BruteForceVectorBackend(dimensions)
}
```

**影响**: 使用 384 维（如 sentence-transformers/all-MiniLM-L6-v2）或 3072 维（如 text-embedding-3-large）模型的用户会在运行时遇到维度不匹配错误。

**修复建议**: 将 `dimensions` 作为 `SqliteStoreConfig` 的可配置参数，默认值 1536。

---

### 16. `SqliteVecBackend` 使用 FNV-1a 32-bit hash 作为 rowid 存在冲突风险

**位置**: `packages/memory/src/vector-backend.ts:265-273`

**问题描述**: `SqliteVecBackend.upsert` 使用 `fnv1a32(point.id)` 将字符串 ID 映射为 32 位整数作为 SQLite 的 rowid。32 位 hash 空间约 42 亿，在大量记录（>10万）时碰撞概率不可忽视。碰撞会导致一个记录静默覆盖另一个。

**代码证据**:
```typescript
public async upsert(point: VectorPoint): Promise<void> {
  const rowid = fnv1a32(point.id)  // 32-bit hash → 可能冲突
  this.upsertStmt!.run([BigInt(rowid), point.embedding])
}
```

**影响**: 记录数增长到一定规模后，两条不同记录可能映射到同一个 rowid，导致数据静默丢失。

**修复建议**: 使用 64-bit hash（如 xxHash64），或在 vec0 表中增加一列存储原始字符串 ID 并在查询时做 join。

---

### 17. 工具调用仅支持串行执行

**位置**: `packages/core/src/agent/index.ts:409-422`

**问题描述**: 工具调用是串行的，没有并行执行路径。

**代码证据**:
```typescript
const results: ToolResult[] = []
for (const call of responseMessage.toolCalls) {
  const result = await this.callToolWithMiddleware(middleware, call, signal, ctx)
  results.push(result)
}
```

**影响**: 当模型并行调用多个工具时，执行时间是所有工具时间的总和，而不是最大值。

**修复建议**: 添加并行工具调用选项。

---

### 18. `streamRun()` 中 ToolCall ID 处理错误

**位置**: `packages/core/src/agent/index.ts:595-610`

**问题描述**: 在处理流式工具调用时，始终使用 `toolAcc.set(0, merged)`，导致所有工具调用都被写入同一个索引。

**代码证据**:
```typescript
case 'tool_call_delta': {
  const key = ev.id ?? '__default__'  // 计算了 key 但没有使用
  const existing = toolAcc.get(0) ?? {...}  // 始终从索引 0 获取
  const merged: ToolCall = {...}
  toolAcc.set(0, merged)  // 始终写入索引 0！
  break
}
```

**影响**: 如果模型并行流式传输多个工具调用，只有最后一个会被保留。

**修复建议**: 使用计算得到的 key 而不是硬编码的 0。

---

### 19. `mergeArgs` 使用 `__raw__` 键可能冲突

**位置**: `packages/core/src/agent/index.ts:180-188`

**问题描述**: 使用 `__raw__` 作为临时存储键，如果工具参数本身包含 `__raw__` 字段，会发生冲突。

**修复建议**: 使用 Symbol 作为键，或使用更独特的命名约定。

---

### 20. `buildRestrictedRegistry` 忽略不存在的工具

**位置**: `packages/core/src/agent/sub-agent.ts:78-89`

**问题描述**: 当 `allowedTools` 包含未注册的工具名时，只是静默跳过，没有任何警告。

**代码证据**:
```typescript
for (const name of allowed) {
  const tool = source.get(name)
  if (tool) restricted.register(tool)  // 不存在就跳过，没有警告
}
```

**影响**: 配置错误（拼写错误等）不会被检测到，用户以为工具可用但实际不可用。

**修复建议**: 添加警告日志或抛出错误。

---

### 21. `ToolRegistry.materializeToolset` 在名称冲突时静默跳过

**位置**: `packages/core/src/tools/index.ts:241-257`

**问题描述**: 当 toolset 中的工具名与已注册工具名冲突时，`materializeToolset` 使用 `if (this.tools.has(name)) continue` 静默跳过，不发出任何警告。

**代码证据**:
```typescript
private materializeToolset(toolset, namespace): void {
  for (const tool of toolset.materialize()) {
    const name = namespace ? `${toolset.id}:${tool.name}` : tool.name
    if (this.tools.has(name)) continue  // 静默跳过！
    this.tools.set(name, tool)
  }
}
```

**影响**: 配置错误（如两个 toolset 定义了同名工具）不会被检测到，用户可能以为所有工具都已注册但实际部分被跳过。

**修复建议**: 添加 `console.warn` 或通过 logger 记录跳过事件。

---

### 22. `ProviderPoolOptionsSchema` 遗漏 `circuit` 字段验证

**位置**: `packages/core/src/agent/pool.ts:127-144`

**问题描述**: `ProviderPoolOptionsSchema` 没有包含 `circuit` 字段的验证，但 `ProviderPool` 构造函数中使用了 `this.circuit = options.circuit`。Zod Schema 是公共验证入口，缺失 `circuit` 意味着通过 schema 验证的配置可能携带未经验证的 circuit breaker 对象。

**代码证据**:
```typescript
// Schema 中缺少 circuit 字段
export const ProviderPoolOptionsSchema = z.object({
  strategy: z.enum(['capability', 'name', 'round-robin', 'weighted']).optional(),
  capability: z.enum([...]).optional(),
  targetId: z.string().min(1).optional(),
  providers: z.array(PooledProviderConfigSchema).optional(),
  random: z.function().optional(),
  // 缺少 circuit！
})

// 但构造函数使用了 circuit
this.circuit = options.circuit  // 未经验证
```

**影响**: 类型安全性降低，通过 schema 验证的配置可能包含无效的 circuit 参数。

**修复建议**: 在 `ProviderPoolOptionsSchema` 中添加 `circuit: z.custom<CircuitBreaker>().optional()`。

---

### 23. `SqliteVecBackend.upsertBatch` 未使用批量事务

**位置**: `packages/memory/src/vector-backend.ts:229-231`

**问题描述**: `upsertBatch` 方法通过循环逐条调用 `upsert`，每条都是独立的 SQL 语句执行，没有使用事务批量提交。对于大量向量的写入，性能会显著下降。

**代码证据**:
```typescript
public async upsertBatch(points: ReadonlyArray<VectorPoint>): Promise<void> {
  for (const p of points) await this.upsert(p)  // 逐条执行，没有事务！
}
```

**影响**: 批量导入文档（如 RAG 管道中的 `ingest`）时性能低下。1000 个 chunk 的文档需要 1000 次独立的 SQL 执行。

**修复建议**: 使用 `db.transaction()` 包装批量操作。

---

### 24. `ProviderPool.stream()` 的 `PoolExhaustedError` 可能传递 undefined

**位置**: `packages/core/src/agent/pool.ts:424-426`

**问题描述**: 当所有候选 provider 的流都产生空输出时（`head.done === true` 路径），`lastError` 被设置为一个新的 `ProviderError`。但如果某个 provider 的 `iter.next()` 没有抛出错误且 `head.done` 不为 `true`（理论上不可能，但类型系统无法保证），`lastError` 可能保持为 `undefined`，导致 `PoolExhaustedError` 携带 `undefined` 的 error。

**代码证据**:
```typescript
let lastError: unknown  // 声明但未初始化
for (const provider of candidates) {
  // ...
  } catch (err) {
    lastError = err
    continue
  }
}
// 如果 lastError 从未被赋值，这里会传递 undefined
throw new PoolExhaustedError(
  candidates.map((p) => ({ providerId: p.id, error: lastError })),
)
```

**影响**: 错误诊断信息丢失，调用者无法从 `PoolExhaustedError.attempts` 中获取真实的失败原因。

**修复建议**: 初始化 `lastError` 为一个默认的 `ProviderError`，或在 `PoolExhaustedError` 构造时检查 undefined。

---

### 25. `middlewareContext` 方法是空操作占位符

**位置**: `packages/core/src/agent/index.ts:798-800`

**问题描述**: `middlewareContext` 方法只是简单返回传入的参数，没有任何处理逻辑。这可能是开发中的占位符，但留在生产代码中会造成困惑。

**代码证据**:
```typescript
private middlewareContext(ctx: MiddlewareContext): MiddlewareContext {
  return ctx  // 只是返回参数，没有任何处理
}
```

**影响**: 代码可维护性降低，读者会误以为这里有上下文增强逻辑。可能遗漏了注入 sessionId、iteration 等上下文信息的逻辑。

**修复建议**: 如果需要上下文增强，添加实际逻辑；如果不需要，删除此方法并直接使用参数。

---

### 26. `ContextCompressionMiddleware` 无状态记录

**位置**: `packages/core/src/agent/middleware/context-compression.ts:97-120`

**问题描述**: 上下文压缩中间件使用 `Record<string, never>` 作为状态类型，没有记录任何压缩操作的信息（如压缩了多少次、压缩了多少条消息、最后压缩时间等）。

**代码证据**:
```typescript
export const createContextCompressionMiddleware = (
  options: ContextCompressionOptions = {},
): AgentMiddleware<Record<string, never>> => {
  // ...
  return {
    name: 'context-compression',
    stateSchema: z.object({}).strict(),  // 空状态
    initialState: {},
    beforeModel: async (messages) => {
      // 执行了压缩但没有任何状态记录
    },
  }
}
```

**影响**: 无法审计压缩操作，调试困难——用户无法知道对话是否被压缩过、压缩了多少次。

**修复建议**: 添加 `compressionCount`、`lastCompressedAt`、`totalMessagesCompressed` 等状态字段。

---

### 27. FTS5 查询过度过滤特殊字符

**位置**: `packages/memory/src/sqlite-store.ts:560-567`

**问题描述**: 在构建 FTS5 查询时，将每个 token 的非字母数字字符全部移除（`replace(/[^a-zA-Z0-9_]/g, '')`）。这会导致包含特殊字符的搜索词丢失重要信息。

**代码证据**:
```typescript
const tokens = query.text
  .split(/\s+/)
  .map((t) => t.replace(/[^a-zA-Z0-9_]/g, ''))  // 移除所有非字母数字字符
  .filter(Boolean)
```

**影响**: 搜索 "C++"、"node.js"、"@lumen/core" 等含特殊字符的术语时，会分别被截断为 "c"、"nodejs"、"lumencore"，导致搜索结果不准确。

**修复建议**: 使用 FTS5 的引用语法 `"token"` 直接引用包含特殊字符的 token，或使用更精细的转义策略。

---

### 28. `persistExtractedFacts` 串行写入影响性能

**位置**: `packages/memory/src/reflector.ts:96-110`

**问题描述**: `persistExtractedFacts` 对每个 fact 执行 `await store.get()` + `await store.put()`，是串行的。当反思提取出大量 facts 时，写入速度慢。

**代码证据**:
```typescript
export const persistExtractedFacts = async (facts, store) => {
  let count = 0
  for (const fact of facts) {
    const existing = await store.get(fact.id)  // 串行查询
    if (existing) continue
    await store.put({...})  // 串行写入
    count += 1
  }
  return count
}
```

**影响**: 当一次反思提取出 20-50 条 facts 时，需要 40-100 次串行的 store 操作。

**修复建议**: 使用 `Promise.all` 并行执行，或在 SqliteStore 中添加批量 put 接口。

---

### 29. `HttpMcpTransport.fetchImpl` 在无全局 fetch 时抛出异常而非返回函数

**位置**: `packages/mcp/src/http-transport.ts:135-141`

**问题描述**: 构造函数中解析 `fetchImpl` 时，如果 `options.fetchImpl` 和 `globalThis.fetch` 都不存在，代码会立即抛出异常。但 `fetchImpl` 是实例属性，应该在实际使用时才检查，或者返回一个会抛出错误的函数，而不是在构造时就抛异常。

**代码证据**:
```typescript
const resolved = options.fetchImpl ?? globalThis.fetch
if (typeof resolved !== 'function') {
  throw new McpTransportError(...)  // 构造时抛异常
}
this.fetchImpl = resolved.bind(globalThis) as typeof fetch
```

**影响**: 在某些测试场景或特殊运行时环境中，可能需要先创建实例再注入依赖。

**修复建议**: 在 `fetchImpl` 被调用时再检查，或返回一个延迟抛出错误的函数。

---

### 30. `OpenAICompatibleProvider.stream()` 的工具调用 ID 可能为空

**位置**: `packages/llm/src/openai-compatible.ts:539-540`

**问题描述**: 在流式工具调用累积中，`acc.id` 初始化为空字符串，只有当 `tc.id` 存在时才会更新。如果服务端在所有 chunk 中都不发送 `id`（某些兼容服务器可能如此），最终的工具调用会有一个空的 `id`，导致后续处理失败。

**代码证据**:
```typescript
const acc =
  toolAcc.get(tc.index) ??
  ({ id: '', name: '', args: '' } as { id: string; name: string; args: string })
if (tc.id) acc.id = tc.id  // 如果 tc.id 始终未定义，acc.id 保持为空
```

**影响**: 某些 OpenAI 兼容服务器（如部分企业网关）可能不遵守标准协议，导致工具调用失败。

**修复建议**: 在累积完成后检查 `acc.id` 是否为空，如果为空则生成一个临时 ID，或在所有 chunk 都没有 ID 时抛出更明确的错误。

---

### 31. `PlanStore.hydrate()` 不验证计划状态的一致性

**位置**: `packages/core/src/plan/index.ts:327-332`

**问题描述**: `hydrate` 方法允许同时存在 `approvedAt` 和 `rejectedAt` 的计划，这在逻辑上是矛盾的（一个计划不可能既被批准又被拒绝）。

**代码证据**:
```typescript
public hydrate(plans: ReadonlyArray<Plan>): void {
  for (const raw of plans) {
    const plan = PlanSchema.parse(raw)  // Zod schema 允许同时存在 approvedAt 和 rejectedAt
    this.plans.set(plan.id, plan)
  }
}
```

**影响**: 从文件恢复的计划可能处于无效状态，导致后续逻辑错误。

**修复建议**: 在 `PlanSchema` 中添加 `refine` 验证，确保 `approvedAt` 和 `rejectedAt` 不能同时存在。

---

### 32. `ClusterOptionsSchema` 未导出

**位置**: `packages/memory/src/meta-reflector.ts:86-92`

**问题描述**: `ClusterOptionsSchema` 是一个私有变量，但对应的接口 `ClusterOptions` 是公开导出的。这导致外部代码无法使用 schema 进行验证，破坏了一致性。

**代码证据**:
```typescript
// 私有
const ClusterOptionsSchema = z
  .object({
    kind: z.string().min(1).optional(),
    similarityThreshold: z.number().min(0).max(1).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict()

// 公开
export interface ClusterOptions {
  readonly kind?: string
  readonly similarityThreshold?: number
  readonly limit?: number
}
```

**影响**: 外部调用者无法获取 schema 进行输入验证，只能依赖运行时检查。

**修复建议**: 将 `ClusterOptionsSchema` 导出为公开变量。

---

### 33. `createLLMPlanner` 的 `MinimalProvider` 接口与真实 Provider 不完全兼容

**位置**: `packages/core/src/plan/index.ts:140-146`

**问题描述**: `MinimalProvider` 接口的 `chat` 方法返回 `{ content: string }`，但实际的 `BaseProvider.chat` 返回 `ChatResponse`（包含 `message`, `raw`, `latencyMs`）。这意味着无法直接传入真实的 provider，必须包装。

**代码证据**:
```typescript
interface MinimalProvider {
  chat(opts: {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }): Promise<{ content: string }>  // 返回类型与真实 provider 不匹配
}
```

**影响**: 使用时需要额外的适配器代码，增加使用复杂度。

**修复建议**: 更新 `MinimalProvider` 接口以匹配 `BaseProvider.chat` 的签名，或提供一个适配器函数。

---

### 34. `createProviderEmbedder` 未传递 `dimensions` 参数给 `EmbedRequest`

**位置**: `packages/memory/src/embedder.ts:109-112`

**问题描述**: `createProviderEmbedder` 接受 `options.dimensions` 参数，但在调用 `source.embed()` 时没有将其传递给 `EmbedRequest`。这意味着即使调用者指定了维度，provider 也不会收到这个参数。

**代码证据**:
```typescript
const response = await source.embed({
  input: texts,
  model: validated.model,
  // 缺少 dimensions！
})
```

**影响**: 调用者无法控制嵌入向量的维度，只能依赖 provider 的默认行为。

**修复建议**: 在 `EmbedRequest` 中传递 `dimensions: validated.dimensions`。

---

### 35. `BaseCron` 的 `run()` 方法没有 `isRunning` 保护

**位置**: `packages/core/src/cron/index.ts:125-148`, `213-235`, `353-375`

**问题描述**: `IntervalCron` 和 `OnceCron` 的 `run()` 方法没有检查 `isRunning` 状态，可能导致同一个 cron 任务同时运行多个实例。

**代码证据**:
```typescript
// IntervalCron.run() — 没有检查 isRunning
public async run(): Promise<void> {
  const startedAt = Date.now()
  try {
    await this.job()  // 如果同时调用两次 run()，会并行执行
    ...
  }
}
```

**影响**: 长时间运行的任务可能被重复调度，导致资源竞争。

**修复建议**: 在 `run()` 开始时检查 `isRunning`，如果已在运行则返回或抛出错误。

---

### 36. `GitTool.execute()` 环境变量合并不安全

**位置**: `packages/tools/src/git/git.ts:193`

**问题描述**: `GitTool` 在调用 `spawn` 时使用 `{ ...process.env, ...env }` 合并环境变量，这会将主机环境的所有变量传递给子进程，包括敏感变量（如 `SSH_AUTH_SOCK`, `GPG_KEY` 等）。

**代码证据**:
```typescript
const child = spawn(execArgv[0]!, execArgv.slice(1), {
  cwd,
  env: { ...process.env, ...env },  // 传递了所有主机环境变量
  stdio: ['ignore', 'pipe', 'pipe'],
  signal: ctx.signal,
})
```

**影响**: 与 `DefaultSandbox` 的安全做法不一致，`DefaultSandbox` 会过滤危险环境变量。

**修复建议**: 使用与 `DefaultSandbox` 相同的环境变量过滤机制，或使用白名单方式合并环境变量。

---

### 37. 子代理不隔离上下文窗口（功能差距）

**参考实现**: Claude Code 子代理每个拥有独立 200K token 上下文  
**lumen 现状**: `sub-agent.ts` 的 `buildAgent` 使用 `new Agent` 复用父代理的 `provider` 和 `tools`，子代理与父代理共享 Provider 状态，但没有真正隔离上下文窗口

**影响**:
- 子代理累积的中间结果（探索输出、日志）会污染父代理上下文
- 无法实现"子代理执行大任务，只返回摘要"的成本优化模式
- 上下文窗口无法突破父代理的 200K 限制

**修复建议**: 在 `Agent` 构造时为子代理分配独立的 `ContextStore` 和 `MemoryStore`，仅通过 `SubAgentMiddleware` 摘要接口与父代理通信。

---

### 38. 缺少子代理自动委派（Auto-Dispatch）

**参考实现**: Claude Code 根据任务特征自动选择 Explore / Plan / general-purpose 子代理  
**lumen 现状**: `SubAgentMiddleware` 仅支持用户显式指定子代理，无自动选择逻辑

**影响**:
- 主代理无法智能判断"何时该委派"
- 用户必须预先指定子代理类型，无法享受 LLM 自动编排的好处
- 缺乏类似 Claude Code `/agents` 描述驱动的自动选择机制

**修复建议**: 实现自动委派器（AutoDispatcher），根据子代理的 `description` 字段与当前任务语义相似度自动选择。

---

### 39. 缺少内置的子代理（Explore/Plan/General-purpose）

**参考实现**: Claude Code 内置 Explore、Plan、general-purpose、statusline-setup、claude-code-guide 五类子代理  
**lumen 现状**: 没有内置任何子代理，用户必须手动配置

**影响**:
- 新用户上手成本高
- 缺少经过验证的"开箱即用"委派模式
- 与成熟 agent 产品的体验差距明显

**修复建议**: 在 lumen 中预置 `ExploreSubAgent`（只读探索）、`PlanSubAgent`（计划生成）、`GeneralPurposeSubAgent`（多步骤任务）三个内置子代理。

---

### 40. 缺少路径作用域规则（Path-scoped Rules）

**参考实现**: Claude Code 支持 `.claude/rules/` 目录下的路径作用域规则，仅在 Claude 访问匹配文件时加载  
**lumen 现状**: `ReflectionMiddleware` 注入全局上下文，无路径作用域机制

**影响**:
- 项目级约定（如 API 目录的 zod 验证规范）会注入到无关任务中
- token 浪费明显，大型 monorepo 中尤为严重
- 缺乏精细化的上下文管理

**修复建议**: 实现 `Rule` 系统，支持 `globs: ["packages/api/**"]` 路径匹配，按需加载规则。

---

### 41. 缺少完整的 Hooks 生命周期事件

**参考实现**: Claude Code 支持 `PreToolUse`、`PostToolUse`、`PreCompact`、`PostCompact`、`Stop`、`SubagentStop` 等事件  
**lumen 现状**: `HookRegistry` 仅有简单的 `dispatch` 机制，缺乏细粒度生命周期事件

**影响**:
- 用户无法在工具调用前注入 lint/format
- 无法在压缩前备份重要对话
- 无法实现"完成时自动通知 Slack"等自动化
- 缺乏 Claude Code Hooks 的丰富生态

**修复建议**: 实现完整的事件总线，支持 `PreToolUse`、`PostToolUse`、`PreCompact`、`Stop`、`UserPromptSubmit` 等事件类型。

---

### 42. 缺少 `/compact` 自动压缩指令

**参考实现**: Claude Code `/compact [保留内容]` 支持用户主动压缩并指定保留范围  
**lumen 现状**: `ContextCompressionMiddleware` 仅在上下文超限时自动触发，用户无法主动触发

**影响**:
- 用户在"上下文快满但还差一点点"时无法主动压缩以保留 token 空间
- 无法指定"保留这些事实，丢弃其他"

**修复建议**: 暴露 `compact()` 方法到 `Agent` 公共 API，支持用户或上层 CLI 触发主动压缩。

---

### 43. 缺少 worktree 隔离执行能力

**参考实现**: Claude Code `isolation: worktree` 支持子代理在独立 git worktree 中运行  
**lumen 现状**: 没有 worktree 概念，所有操作共享同一工作目录

**影响**:
- 并行子代理可能产生文件冲突
- 实验性任务可能污染主分支
- 无法实现"试运行、对比、合并"的工作流

**修复建议**: 在子代理配置中支持 `isolation: 'worktree' | 'directory'`，创建独立 git worktree 作为工作目录。

---

### 44. 缺少多渠道适配器（Multi-channel）

**参考实现**: OpenClaw 内置 WhatsApp、Telegram、Discord、Slack、Teams 适配器  
**lumen 现状**: 没有适配器层，仅支持 CLI

**影响**:
- 用户无法通过手机聊天应用访问 agent
- 移动端体验缺失
- 无法在团队频道中嵌入 agent

**修复建议**: 实现 `ChannelAdapter` 接口，提供 Slack、Telegram、Discord 等适配器实现。

---

### 45. 缺少 People-aware Memory（人物感知）

**参考实现**: OpenClaw 2026.4.29 引入"people-aware wiki"，每个事实链接回源对话和参与者  
**lumen 现状**: `MemoryStore` 仅存储事实文本，无人物维度的元数据

**影响**:
- 多人协作场景下事实归属不清
- 无法实现"张三告诉我..."类型的上下文
- 合规审计能力不足

**修复建议**: 在 `MemoryFact` schema 中增加 `sourceUserId`、`sourceConversationId` 字段，构建反向索引。

---

### 46. 缺少视觉/图像分析能力

**参考实现**: OpenClaw、Claude Code 均内置 vision 能力  
**lumen 现状**: 工具输出仅为文本/JSON，无图像输入支持

**影响**:
- 用户无法发送截图让 agent 理解
- UI 调试、错误排查受限
- 与 Claude Code 的多模态能力差距明显

**修复建议**: 在 `Message` schema 中支持 `image` 字段，并在 provider 层接入 vision API。

---

### 47. MCP 安全策略默认宽松（应默认 fail-closed）

**参考实现**: OpenClaw 2026.4.27 引入"fail-closed MCP"机制，未通过验证的 MCP 调用直接拒绝  
**lumen 现状**: `McpClient` 默认接受所有 MCP server，未实现显式安全配置文件

**影响**:
- 恶意 MCP server 可执行任意操作
- 缺乏 `security.yaml` 风格的显式配置文件
- 与企业级安全要求差距大

**修复建议**: 引入 `SecurityProfile`，所有 MCP server 必须显式声明工具权限范围。

---

### 48. 缺少并行 MCP/子代理初始化

**参考实现**: Claude Code 2026.4.24 起子代理和 MCP 连接并行初始化，启动时间减少 60%  
**lumen 现状**: `McpRegistry.loadAll` 串行初始化所有 MCP server，`SubAgentMiddleware` 串行创建子代理

**影响**:
- 启动时间随 MCP server 数量线性增长
- 子代理创建阻塞主代理响应
- 大型部署中性能问题突出

**修复建议**: 在 `McpRegistry.loadAll` 中使用 `Promise.all` 并行初始化，对子代理创建也实现并行预热。

---

### 49. 缺少 Background Task 异步执行模式

**参考实现**: Claude Code 支持 `background: true` 后台运行、Ctrl+B 切换、Agent View 监控  
**lumen 现状**: `StreamRunOptions` 没有 background 选项，所有任务同步阻塞

**影响**:
- 长任务（如代码库全量分析）期间用户界面冻结
- 无法并发运行多个独立任务
- 缺乏"开火后忘记"的工作模式

**修复建议**: 实现 `BackgroundTaskRegistry`，将长任务注册为后台任务，暴露 `status`、`cancel` 接口。

---

### 50. 缺少 Agent View 统一管理界面

**参考实现**: Claude Code Agent View 集中显示所有子代理状态、上下文使用、运行时间  
**lumen 现状**: 没有可视化界面，CLI 仅能显示当前任务

**影响**:
- 用户无法总览所有运行中的子代理
- 调试多代理系统时缺乏透明度
- 运维成本高

**修复建议**: 实现 `AgentViewProvider` 接口，提供 CLI 表格视图或 Web 仪表盘。

---

### 51. 缺少主动执行（Proactive Execution）能力

**参考实现**: OpenClaw 支持 heartbeat-delivered reminders（心跳触发的提醒），可在指定时间主动执行任务  
**lumen 现状**: `BaseCron` 仅在 `cron.ts` 中实现，但未与 Agent 主循环集成

**影响**:
- agent 无法在用户不在线时主动执行定时任务
- 与 OpenClaw 的"24/7 content moderation"等场景差距大
- 定时任务缺乏 agent reasoning 能力

**修复建议**: 实现 `ProactiveAgent` 包装，集成 Cron 调度与 Agent 循环。

---

### 52. 缺少 Manifest-first 元数据加载

**参考实现**: OpenClaw 2026.4.29 引入 manifest-first 元数据，Provider 复用模型目录无需重复发现  
**lumen 现状**: 每次 `createAgent` 都会重新创建 Provider，没有 manifest 缓存

**影响**:
- 启动时间因 Provider 数量增加而增长
- 模型发现逻辑每次执行都跑一遍

**修复建议**: 实现 `ProviderManifest` 缓存层，启动时一次性发现并缓存所有 Provider 元数据。

---

### 53. 缺少按角色权限隔离（Permission Modes）

**参考实现**: Claude Code 支持 `default`、`acceptEdits`、`auto`、`dontAsk` 四种 permissionMode  
**lumen 现状**: `ToolPermissionMiddleware` 仅支持 allow/deny/ask 三态

**影响**:
- 缺少"自动接受所有编辑"等场景的便利模式
- 缺少"完全不询问"模式用于受信任环境
- 用户体验不够灵活

**修复建议**: 扩展 `PermissionMode` 枚举支持更多模式。

---

### 54. 缺少 Apply Patch 工具

**参考实现**: Claude Code 拥有专门的 `apply_patch` 工具，结构化修改多文件  
**lumen 现状**: `PatchTool` 存在但实现较简单，缺少结构化的多文件 patch

**影响**:
- 多文件原子修改能力弱
- 大型重构时代码生成质量受限
- 缺少 Claude Code patch 格式的标准化

**修复建议**: 增强 `PatchTool` 支持 Claude Code 兼容的 `*** Begin Patch` 格式。

---

## 四、P3 次要问题 (Minor)

这些是代码质量、性能优化和次要功能问题，对核心功能影响较小。

### 55. `SqliteCheckpointStore` 使用 `better-sqlite3` 的同步 API 但包装在 async 方法中

**位置**: `packages/memory/src/sqlite-checkpoint-store.ts:156-189`

**问题描述**: `save`、`get`、`list`、`delete` 等方法都是 `async`，但内部使用的是 `better-sqlite3` 的同步 API（`stmt.run()`、`stmt.get()`、`stmt.all()`）。这是一种反模式——async 方法应该包含真正的异步操作。

**代码证据**:
```typescript
public async save(checkpoint: AgentCheckpoint): Promise<AgentCheckpoint> {
  this.stmts.insert.run(checkpointToRow(checkpoint))  // 同步操作
  return checkpoint
}
```

**影响**:
- 调用者误以为是异步操作，可能做不必要的 await
- 同步阻塞可能影响事件循环，尤其是在高频调用场景

**修复建议**: 如果保持同步实现，移除 `async` 关键字；如果需要异步，考虑使用支持 Promise 的 SQLite 库（如 `sqlite`）或在 worker 线程中执行。

---

### 56. `SkillRegistry.activate()` 和 `applyActive()` 串行执行

**位置**: `packages/skills/src/registry.ts:64-83`

**问题描述**: `activate()` 和 `applyActive()` 都是通过 `for...of` 循环串行执行每个 skill 的 `shouldActivate()` 和 `apply()`，没有并行化。

**代码证据**:
```typescript
public async activate(ctx: SkillContext): Promise<ActivatedSkill[]> {
  const out: ActivatedSkill[] = []
  for (const skill of this.skills.values()) {
    const activation = await skill.shouldActivate(ctx)  // 串行
    if (activation.active) out.push({ skill, activation })
  }
  return out.sort(...)
}
```

**影响**: 当注册了多个技能时，激活和应用的延迟会线性增长。

**修复建议**: 使用 `Promise.all` 并行执行 `shouldActivate()` 和 `apply()`。

---

### 57. `globLikeMatch` 使用 `^` 和 `$` 锚定导致不完全匹配

**位置**: `packages/skills/src/base.ts:161-167`

**问题描述**: `globLikeMatch` 将模式转换为正则表达式时添加了 `^` 和 `$` 锚定，这意味着模式必须完全匹配整个路径，而不是路径的一部分。对于 `glob` 类型的触发器，通常期望模式匹配路径的前缀或包含关系。

**代码证据**:
```typescript
export const globLikeMatch = (pattern: string, value: string): boolean => {
  if (pattern === '*') return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(value)  // 完全匹配
}
```

**影响**: 模式 `*.ts` 无法匹配路径 `src/utils/helper.ts`，因为路径不完全等于 `*.ts`。

**修复建议**: 移除 `^` 和 `$` 锚定，或根据 trigger 的意图决定是否需要完全匹配。

---

### 58. `TerminalTool.execute()` 中重复导入 `path` 模块

**位置**: `packages/tools/src/shell/terminal.ts:185`

**问题描述**: `terminal.ts` 在文件顶部已经导入了 `path` 模块（第31行），但在 `execute` 方法中又使用 `require('node:path').resolve()`。这是不必要的重复导入，增加了代码混乱。

**代码证据**:
```typescript
// 顶部已导入
import path from 'node:path'

// ... 在 execute 方法中
const cwd = parsed.cwd ? require('node:path').resolve(ctx.cwd, parsed.cwd) : ctx.cwd
```

**影响**: 代码不一致，增加维护成本。

**修复建议**: 使用已导入的 `path` 模块：`path.resolve(ctx.cwd, parsed.cwd)`。

---

### 59. `TerminalTool.sandboxTimeoutMs()` 硬编码超时时间

**位置**: `packages/tools/src/shell/terminal.ts:244-249`

**问题描述**: `sandboxTimeoutMs()` 方法硬编码返回 30_000（30秒），但 `DefaultSandbox` 从配置中获取超时时间。当用户通过 `ShellSandboxConfig.timeoutMs` 设置了不同的超时时间时，工具调用时仍会使用硬编码的 30 秒。

**代码证据**:
```typescript
private sandboxTimeoutMs(): number {
  // The DefaultSandbox already holds the timeout; we don't have
  // a way to ask it back. Hardcode the default here as a fallback
  // for the NoneSandbox case.
  return 30_000
}
```

**影响**: 用户配置的超时时间在 `terminal` 工具调用时不生效，只能通过每次调用的 `timeoutMs` 参数覆盖。

**修复建议**: 在 `ShellSandbox` 接口中添加 `getTimeoutMs()` 方法，或在 `TerminalTool` 构造时缓存配置的超时时间。

---

### 60. `GitTool.execute()` 在信号已中止时仍会启动进程

**位置**: `packages/tools/src/git/git.ts:190-232`

**问题描述**: `execute` 方法创建了一个新的 Promise 并在其中调用 `spawn`，但没有检查 `ctx.signal.aborted` 是否已为 `true`。如果信号已经中止，进程仍然会被创建。

**代码证据**:
```typescript
return new Promise((resolve) => {
  const child = spawn(execArgv[0]!, execArgv.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: ctx.signal,
  })
  // 没有检查 ctx.signal.aborted
  // ...
})
```

**影响**: 在已中止的上下文中仍然会启动 git 进程，浪费资源。

**修复建议**: 在 `spawn` 之前检查 `if (ctx.signal.aborted) return resolve({...error})`。

---

### 61. `WebFetchTool.execute()` 重复截断响应

**位置**: `packages/tools/src/web/index.ts:365-372`

**问题描述**: `DuckDuckGoSearchProvider.fetch` 在 `readCapped` 方法中已经根据 `maxBytes` 截断了响应，但 `WebFetchTool.execute` 又再次调用 `text.slice(0, parsed.maxBytes)`。这导致双重截断，且 `truncated` 标志的判断逻辑不正确（因为文本已经被 `readCapped` 截断过）。

**代码证据**:
```typescript
// DuckDuckGoSearchProvider.fetch
const html = await this.readCapped(res, maxBytes)  // 已截断

// WebFetchTool.execute
const text = await this.provider.fetch(parsed.url, parsed.maxBytes)
return WebFetchOutputSchema.parse({
  text: text.slice(0, parsed.maxBytes),  // 再次截断
  truncated: text.length > parsed.maxBytes,  // 永远为 false
})
```

**影响**: `truncated` 标志永远为 `false`，因为文本已经在 `readCapped` 中被截断了。

**修复建议**: 修改 `BaseSearchProvider.fetch` 返回包含截断标志的结构，或移除 `WebFetchTool` 中的重复截断逻辑。

---

### 62. `RingBufferWorkingMemory.append()` 使用 O(n) 的 `shift()`

**位置**: `packages/core/src/memory/working-memory.ts:113-121`

**问题描述**: `append` 方法使用 `push()` + `shift()` 实现环形缓冲区，其中 `shift()` 是 O(n) 操作。虽然注释中说明典型容量为 50，但对于较大的容量或高频写入场景，这会成为性能瓶颈。

**代码证据**:
```typescript
public append(record: MemoryRecord, score: number): void {
  this.items.push({ record, score, appendedAt: Date.now() })
  if (this.items.length > this.capacity) {
    // `shift` is O(n) on a JS array; we accept that
    // because the typical capacity is 50 and append is
    // not a hot path.
    this.items.shift()
  }
}
```

**影响**: 当容量较大或写入频繁时，性能下降。

**修复建议**: 实现真正的环形缓冲区（使用索引指针），使 `append` 和 `recent` 都为 O(1) 操作。

---

### 63. `SessionGate.open()` 使用 O(n) 的查找

**位置**: `packages/core/src/multi-user/index.ts:305-311`

**问题描述**: `open` 方法通过 `[...this.sessions.values()].find((s) => s.userId === userId)` 查找用户的现有会话，这是一个 O(n) 操作。每次用户打开会话都需要遍历所有会话。

**代码证据**:
```typescript
public async open(userId: string, title = 'untitled'): Promise<UserSession> {
  const existing = [...this.sessions.values()].find((s) => s.userId === userId)
  // ...
}
```

**影响**: 当会话数量增加时，查找性能线性下降。

**修复建议**: 添加一个反向索引 `userId -> sessionId` 的 Map，使查找变为 O(1)。

---

### 64. `DuckDuckGoSearchProvider.parse()` 使用正则表达式解析 HTML

**位置**: `packages/tools/src/web/index.ts:194-212`

**问题描述**: `parse` 方法使用正则表达式解析 DuckDuckGo 的 HTML 响应。正则表达式不是解析 HTML 的可靠方式，当页面结构变化时会导致解析失败。

**代码证据**:
```typescript
private parse(html: string, limit: number): ReadonlyArray<SearchResult> {
  const results: SearchResult[] = []
  const blockRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  // ...
}
```

**影响**: 依赖页面 HTML 结构，容易因网站改版而失效。

**修复建议**: 使用 DuckDuckGo 的 API 端点（如 `api.duckduckgo.com`）或使用专门的 HTML 解析库。

---

### 65. `createTrace` 使用通用 Error 而非自定义错误类型

**位置**: `packages/core/src/trace.ts:76-98`

**问题描述**: `createTrace` 在验证失败时抛出通用 `Error`，而不是使用项目中定义的 `ValidationError`。这与项目的错误处理约定不一致。

**代码证据**:
```typescript
if (!isHex(traceId, 16)) {
  throw new Error('createTrace: traceId must be 16 hex characters')  // 应该使用 ValidationError
}
```

**影响**: 调用方无法通过 `instanceof` 区分验证错误和其他错误。

**修复建议**: 使用 `ValidationError` 替换通用 `Error`。

---

### 66. `HookRegistry.dispatch()` 使用 `console.error` 而非日志系统

**位置**: `packages/core/src/hooks/index.ts:69`

**问题描述**: `dispatch` 方法在钩子抛出错误时使用 `console.error`，而不是项目的日志系统。这使得错误处理不一致，且难以在生产环境中统一收集和管理。

**代码证据**:
```typescript
} catch (err) {
  // Swallow — agent must be robust to hook bugs.
  // Production code should also log this.
  // eslint-disable-next-line no-console
  console.error('[lumen/hooks] hook threw:', err)
}
```

**影响**: 日志分散，难以集中管理和监控。

**修复建议**: 使用项目的日志系统（如 `@lumen/core` 的 `logging` 模块）记录错误。

---

### 67. 缺少 Skill 参数化调用

**参考实现**: Claude Code Skill 支持 `$ARGUMENTS` 占位符和命名参数  
**lumen 现状**: `SkillRegistry.activate()` 不支持参数替换

**影响**:
- Skill 模板无法参数化
- 用户无法 `/code-review <branch>` 这样传参
- 复用性受限

**修复建议**: 在 `SkillSpec` 中增加 `arguments` 字段，在激活时执行模板替换。

---

### 68. 缺少失败降级到本地模型的能力

**参考实现**: OpenClaw 支持在 API key 失效时降级到本地 Ollama 模型  
**lumen 现状**: `ProviderPool` failover 仅在同一类型的 Provider 之间切换

**影响**:
- 网络故障或 API 限流时无法继续工作
- 缺少"在线 + 本地"双模兜底

**修复建议**: 扩展 `ProviderPool` 支持跨类型降级（OpenAI → Anthropic → Ollama）。

---

### 69. 缺少 `/loop` 定时循环指令

**参考实现**: Claude Code `/loop` 调度周期性 prompt  
**lumen 现状**: `BaseCron` 存在但未暴露为 skill 或 slash command

**影响**:
- 用户无法使用"每小时检查一次"等便利功能
- 定时任务与 agent reasoning 未结合

**修复建议**: 将 `BaseCron` 包装为 `/loop` skill，支持 cron 表达式和自然语言。

---

### 70. 缺少 `/init` 项目自检能力

**参考实现**: Claude Code `/init` 自动扫描项目并生成 CLAUDE.md  
**lumen 现状**: 没有 `/init` 等价的项目分析工具

**影响**:
- 新项目上手需要手动配置
- 项目知识无法自动捕获

**修复建议**: 实现 `ProjectAnalyzer` skill，自动检测 build 命令、目录结构、依赖等。

---

### 71. 缺少 `/cost` / `/usage` 详细用量统计

**参考实现**: Claude Code `/cost` `/usage` 提供详细 token 和成本数据  
**lumen 现状**: `Budget` 跟踪但未暴露为用户可查询接口

**影响**:
- 用户无法实时查看 token 消耗
- 成本控制能力受限

**修复建议**: 暴露 `getUsage()` 方法到 `Agent` 公共 API。

---

### 72. 缺少失败重试的语义保持

**参考实现**: Claude Code 支持"让我重新尝试"语义，子代理失败时自动重试  
**lumen 现状**: `withRetry` 仅在 Provider 层面重试，工具调用失败不重试

**影响**:
- 网络抖动导致整个任务失败
- 用户体验差

**修复建议**: 扩展重试机制覆盖到工具调用层。

---

### 73. 缺少统一事件总线（Event Bus）

**参考实现**: OpenClaw Gateway 维护事件循环，提供 readiness 诊断和事件总线  
**lumen 现状**: 各模块独立处理事件，没有统一的事件流

**影响**:
- 模块间通信松散，难以实现复杂的跨模块响应
- 监控和调试受限

**修复建议**: 实现 `EventBus`，提供发布-订阅模式的事件流。

---

## 五、架构重构建议

### AR-1. 统一执行路径
将 `run()` 和 `streamRun()` 的公共逻辑提取到 `executeLoop()` 方法，参数化同步/异步差异。

### AR-2. 中间件流式适配
为中间件添加 `streamBeforeModel`/`streamAfterModel` 钩子，或在流式路径中复用现有钩子。

### AR-3. 子代理工厂
创建 `createSubAgent` 工厂函数，复用 `createAgent()` 的中间件注入逻辑。

### AR-4. 状态视图机制
实现 `MiddlewareStateView.set()` 的运行时验证，防止越权修改。

### AR-5. Provider 池分级降级
在 `ProviderPool` 中实现跨类型降级策略，扩展 `failover` 链支持本地模型兜底。

### AR-6. 统一事件总线
建立模块间标准事件流，支持 `PreToolUse` / `PostToolUse` / `PreCompact` 等生命期事件。

---

## 六、总结

Lumen 的核心架构设计良好（组合根模式、中间件扩展、插件化设计），但存在 **73 个待解决问题**，按优先级统计如下：

| 优先级 | 数量 | 关键类别 |
|--------|------|----------|
| P0 严重缺陷 | 2 | 中间件绕过、安全失控 |
| P1 重要问题 | 8 | 中间件状态、上下文隔离、浏览器/Computer Use |
| P2 中等问题 | 44 | 性能、可靠性、安全、架构差距 |
| P3 次要问题 | 19 | 代码质量、小功能、UX 细节 |

### 关键洞察

1. **流式路径完全绕过安全机制** 是最关键的问题（#1），意味着生产环境中 CLI/TUI 用户的权限策略形同虚设
2. **子代理不受父代理的安全策略约束**（#2、#3），可能被滥用绕过限制
3. **与 OpenClaw / Claude Code 相比，lumen 在 5 个核心能力上完全缺失**：浏览器自动化、Computer Use、子代理自动委派、视觉/多模态、Background Task
4. **代码重复**（#11）导致维护困难和行为不一致
5. **中间件状态管理**（#4、#5、#6）违反设计规范，影响系统的可观测性和可审计性

### 推荐修复顺序

1. **第一波（立即）**: 修复 #1、#2、#3 — 这三个问题直接威胁生产安全
2. **第二波（短期）**: 修复 #4、#5、#6、#7、#8 — 改进中间件系统的正确性
3. **第三波（中期）**: 实现 #9、#10、#37、#38、#39、#41 — 补齐核心功能差距
4. **第四波（长期）**: 推进 #48、#49、#50、#51、#52、#53、#54 — 完成与 OpenClaw/Claude Code 的功能对齐
5. **持续**: 解决 P3 类问题，提升代码质量和开发体验
