# P21 Design — Durable execution + long-running agents

> **P21 是 lumen 在 P19+ middleware 范式落地之后的"应用层范式"扩展。**
> P19–P20 解决了 "agent loop + middleware + 编排 + 反思 + 工具"；
> P21 解决 "agent loop 跨**时间**的**可恢复性**" — 一个跑了 30 分钟
> 的 agent 在第 100 步因网络崩溃挂掉，重启后能**无缝**从第 100 步
> 继续，不是从第 1 步重跑。

设计基线日期：2026-07-10。基于本目录下其他 design basis
（P19-DESIGN.md、P20.7-agent-team.md、p19.5-meta-reflector-design-basis.md）
和 4 框架 docs fetch（langchain.com / langgraph / openclaw.ai /
docs.claude.com） 验证 2026-07。

## 0. 为什么是 P21

### 0.1 4-framework fetch 验证（2026-07-10）

Lumen 的 P19+ 范式建立在 P19-DESIGN.md §3.4 / §4.4 的 4 框架对比
上。P21 必须 fetch 同一组框架的 2026 H2 最新内容来定方向。

**LangChain + LangGraph（2026-07-08 抓取 `langchain.com` blog +
`docs.langchain.com/oss/python/langgraph/overview`）：**

- **NemoClaw Deep Agents Blueprint**（与 NVIDIA 合作，7-8 月发布）— 主题是"long-running deep agent"
- **LangGraph 1.0** 主页宣称的低层能力清单：
  > "durable execution, streaming, human-in-the-loop, and persistence"
- **LangSmith** 主线产品：Observability + Evals + "Agent Improvement Engine" + "Sandboxes" + "Fleet"

**Claude Code（2026-07 抓取 `docs.claude.com/en/docs/claude-code/overview`）：**

- 重点页："How Claude Code works" / "Explore the .claude directory" / "Store instructions and memories" / "Permission modes" / "Manage sessions"
- "Permission modes" 是 Claude Code 2026 H2 的差异化方向（plan mode + auto-accept mode + ...）

**OpenClaw（2026-07-10 抓取 `openclaw.ai` + `openclaw.ai/blog`）：**

- 主页仍是 "Personal AI Assistant" 标签，blog 提 "Skills / Agents / Workflow / Security / Nvidia ClawHub / Codex Approvals"
- **P19.5 结论保留**：OpenClaw 公开内容只覆盖 personal-assistant / chat-platform gateway，没有 enterprise agent framework 内容。"OpenClaw daily→long-term 蒸馏"在公开 docs 上**仍然无证据**。

### 0.2 P21 候选 + 选 durable execution

按 fetch 验证排序的候选：

| 方向 | LangGraph 1.0 / Claude Code 主线? | Lumen 现状 | 选? |
|---|---|---|---|
| Durable execution | LangGraph 1.0 #1 capability | 仅 throw-path save（P20.4） | ✅ |
| Memories（long-term）| Claude Code 主线 | `SqliteStore`（事实）+ skill registry |  |
| Observability + Eval | LangSmith 主线 | P20.8 trace + P20.10 dataset | 已 ship |
| Multi-agent deep agents | NemoClaw 主题 | P19.3/4 + P20.7 全 ship |  |
| Permission modes | Claude Code 主线 | P20.1 interrupt 基础 |  |

P21 选 **durable execution**：
- **Lumen 最大 gap**：P20.4 SqliteCheckpointStore 存在，但只在
  throw path save，**没有** "每个 step 自动 save + 自动 resume" 范式
- **LangGraph 1.0 主线**：durable execution 是该项目的核心差异化卖点
- **可复用现有 P20.4**：BaseCheckpointStore + SqliteCheckpointStore 已经 ship；P21 是把"用 store" 升级到"系统化用 store"
- **不是新抽象**：`Agent.run` 已经支持 `resumeFrom?: AgentCheckpoint`，P21 是把"用户手动 resume"升级到"系统自动 resume"

### 0.3 6-question audit（P21 之前）

P19 6 问审计 (`docs/PITFALLS.md` §6-question audit) 揭示 lumen 的
"missing capability" 经常是"已在树里但没 wire"。P21 也走一遍：

1. **Skill 持久化**？P20.6 skill trigger 已 ship
2. **Team 持久化**？P20.7.4 team-level checkpoint 已 ship
3. **Workspace 持久化**？`SqliteStore` + `SqliteCheckpointStore` 都 ship
4. **Context 持久化**？`lumen_chat` TUI memory（`SqliteStore`）ship
5. **Failure 恢复**？`resumeFrom` 字段 ship，**但只 throw 时 save**
6. **Security**？P20.1 interrupt + ToolRisk 三档 ship

→ Q5 是 P21 唯一明显 gap。

## 1. P21 核心定义

**Durable execution**：一个 long-running agent 在任意 step 之后
**都能被中断 + 重启 + 继续**，中间不需要 operator 干预。

形式化：
- 给定 `Agent.run(options, step, messages)` 当前 state
- 在 step `S` 中断
- 重启后 `Agent.run(resumeFrom: checkpointAtStep(S))` 必须能产生
  step `S+1` 与"从未中断过"运行时**完全相同**的 state

Lumen P21 = "把 `resumeFrom` 从手动 API 升级到 `Agent.run` 默认
行为"。

## 2. P21 任务分解

### 2.1 P21.0 — Durable step checkpoint

- `Agent.run` 内部在**每个 step:end** 时自动 save checkpoint（不只在 throw path）
- 接受 `checkpointInterval?: number`（默认 1 = 每 step save；P20.4 默认只在 throw save，新默认覆盖）
- `checkpointStore` 是 `AgentRunOptions` 的字段（已有）保持
- 风险：频繁 IO；用 `checkpointInterval: N` 让 caller 调
- **不**改 public API surface；只改 `Agent.run` 内部行为

### 2.2 P21.1 — Auto-resume on startup

- `lumen run` CLI 在启动时检查 `--checkpoint <path>` 指向的 sqlite file
- 如果 file 里有**最近 N 分钟内**的未完成 checkpoint，自动从那里 resume
- "未完成" = checkpoint 标记 `outcome = 'in_progress'`（P20.4 没这字段，P21 加）
- "N 分钟" = 防止 stale checkpoint 误 resume（默认 10 分钟）
- `--no-resume` flag 强制 fresh start

### 2.3 P21.2 — Heartbeat checkpoint integration

- P20.2 `startHeartbeat` + `runWithHeartbeat` 已经有
- P21 集成：`runWithHeartbeat({ heartbeatMs: 30000, checkpointStore, checkpointIntervalMs: 60000 })` — 每 60s save 一次 + 每 30s 发 heartbeat
- 给"long-running cron-style agent"用（`apps/cli/cron.ts` 已有 P15 hookup）

### 2.4 P21.3 — 4-framework 对比 + bench

- 与 LangGraph 1.0 checkpointer + Durable Execution 对比（验证 P21 不掉队）
- 与 Claude Code "Store instructions and memories" + permission modes 对比
- 5 scenario bench（参考 P19.7.5）测：
  1. 100-step agent 在 step 50 中断后 resume 时间
  2. heartbeat + checkpoint 集成场景的 wall-clock
  3. 100 concurrent durable runs 的 sqlite write throughput
  4. checkpoint file size growth (per step) + 滚动策略
  5. resume-from-stale-checkpoint 失败路径

## 3. 4-framework 对比

| 维度 | LangGraph 1.0 | Claude Code | OpenClaw | Lumen P21 |
|---|---|---|---|---|
| **durable execution** | ✅ checkpointer + thread_id | ⚠️ "Store instructions and memories"（CLI session 持久化，但 agent loop step-level 不知） | ❌ 未公开 | ✅ Agent.run 默认 step checkpoint + auto-resume |
| **checkpoint trigger** | 每个 super-step | session end | ❌ | 每个 step（`checkpointInterval=1`） + 显式 |
| **resume API** | `thread_id` + `get_state` | `claude --continue <session-id>` | ❌ | `resumeFrom: AgentCheckpoint`（已有 P20.4） + auto-resume（new P21） |
| **stale checkpoint 防护** | 显式 `thread_id` 区分（no TTL） | 无 | 无 | 10 分钟 TTL（new P21.1） |
| **storage backend** | postgres/sqlite/redis（in-thread） | local file + cloud | ❌ | sqlite（已有 P20.4）+ memory backend |
| **long-running pattern** | durable execution | permission mode "auto-accept" | ❌ | runWithHeartbeat（已有 P20.2）+ checkpoint interval（new P21） |
| **bench** | LangSmith trace replay | ❌ | ❌ | 5 scenario bench（new P21.3） |

Lumen P21 在 4 框架中**唯一**有：
- **TTL-based stale checkpoint 防护**（Claude Code / LangGraph 都没
  有，是 lumen 自己的设计）
- **5-scenario bench**（验证"durable"声称可重现）

Lumen P21 借鉴 LangGraph 1.0：durable execution 概念 + checkpointer 抽象
Lumen P21 借鉴 Claude Code：long-running 模式（`runWithHeartbeat`）

## 4. 关键设计决策

1. **默认 step-level checkpoint**（不 throw-path only）
   - LangGraph 1.0 默认每个 super-step save；Lumen P21 同样
   - Caller 用 `checkpointInterval: N` 调成"每 N step save"压 IO
2. **TTL-based stale 防护**（非 LangGraph / Claude Code 的模式）
   - Auto-resume 之前 check `Date.now() - checkpoint.createdAt < 10min`
   - 超过 10 分钟的 checkpoint **不** auto-resume；fall back to fresh start
3. **outcome: 'in_progress' 标记**
   - P20.4 AgentCheckpoint 缺这字段；P21 加（`.optional()`，back-compat）
   - run 成功 → outcome='success'；run 抛错 → outcome='error'（已有逻辑）；step checkpoint → outcome='in_progress'
4. **resumeFrom 不改 API**
   - 已有 `AgentRunOptions.resumeFrom: AgentCheckpoint`
   - P21 不动 field；改 `Agent.run` 内部行为：auto-detect from
     `checkpointStore.getLastInProgress(sessionId)` 当 `resumeFrom` 缺省且 `sessionId` 存在
5. **不** 引入新抽象
   - P19+ rule 14：BaseCheckpointStore 已经 ship，2 个实现（InMemory + Sqlite）满足
   - 1 个实现 = wrapper（MemoryBackend 之类）**不**该有
6. **P21 整体不依赖 LLM call**
   - checkpoint save / resume 是纯 IO；fetch 真实 docs 后**不**需要新
     LLM call
   - bench scenario 1-5 用 mock provider（沿用 P19.7.5 FakeProvider）
7. **不** 进 4 框架的"shared durable interface" race
   - LangGraph 1.0 checkpointer 接口不是 cross-framework 标准
   - lumen 用自己的 `BaseCheckpointStore`（已有），**不**抽象"通用
     durable backend"（P19+ rule 15 helper > abstract）

## 5. 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| Step-level checkpoint 拖慢每步 IO | 默认 `checkpointInterval=1`；caller 调成 N；sqlite WAL 模式已 ship |
| Stale checkpoint 误 resume | TTL=10min + outcome='in_progress' 标记 |
| Resume 后 state 不一致 | 已有 `resumeFrom` 字段语义 + 4 framework 对比验证（Lumen 跟 LangGraph checkpointer replay 行为一致） |
| Bench scenario 5（stale resume 失败）flaky | 用 `vi.useFakeTimers()` 控制时间 |
| P21 侵入 `Agent.run` loop 破坏 P19.0 middleware 兼容性 | P21.0 单元测试覆盖 step checkpoint + middleware order |

## 6. 总预算

- 4 P-ticket × 平均 2-3 commit = **~10 commit**
- 5 bench scenario + integration test
- +500~+800 行代码（durable execution 范式 + bench harness）
- +400~+600 行测试
- +500 行 docs（本文件 + VitePress 同步）

## 7. 关键决策（2026-07-10 收口）

1. **P21 = durable execution**（不是 memories / observability / permission modes）
2. **Step-level checkpoint default**（沿用 LangGraph 1.0）
3. **TTL-based stale 防护**（lumen 自己的设计，4 框架没有）
4. **不**改 public API surface（`AgentRunOptions.resumeFrom` 已有）
5. **不**进 4 框架 race（不抽象"通用 durable backend"）
6. **P21 整体不依赖 LLM call**（纯 IO + 状态机）

## 8. 引用

- LangChain blog 2026-07 (`https://blog.langchain.com/`) — NemoClaw Deep Agents Blueprint
- LangGraph 1.0 overview (`https://docs.langchain.com/oss/python/langgraph/overview`) — durable execution 概念
- Claude Code docs (`https://docs.claude.com/en/docs/claude-code/overview`) — memories + permission modes
- OpenClaw blog (`https://openclaw.ai/blog`) — 仍为 personal assistant；P19.5 结论保留
- Lumen P19-DESIGN.md — 中间件范式 + 4 框架对比
- Lumen P20.7-agent-team.md — agent team 编排
- Lumen p19.5-meta-reflector-design-basis.md — cross-run reflection

**Lumen P21 不依赖 hermes / OpenClaw / LangChain SaaS 启动**。本
design doc 是 lumen 自身的设计资产，自维护。
