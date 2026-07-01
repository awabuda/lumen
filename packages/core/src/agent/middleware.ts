/**
 * Middleware 范式 spec (P19.0.1) — Agent loop 的扩展点。
 *
 * 设计原则（CLAUDE.md P19+ rules 11-15 + P19-DESIGN.md §1）:
 *   1. **任何"对 Agent loop 的扩展" = middleware**。禁止在 AgentConfig
 *      上堆 boolean flags（`enablePlan` / `enableReflection` / `enableSkill`）。
 *   2. **任何"对 Agent state 的语义" = Zod state schema**。中间件 state
 *      必须是 Zod discriminated union，append-only，不允许往 root state
 *      偷加字段。
 *   3. **interface + function**。helper function 优于 abstract class
 *      （CLAUDE.md rule 15）。Middleware 是一个 plain object，不是
 *      抽象类。提供具名 helper function（`createPlanMiddleware` 等），
 *      不强制用户继承。
 *   4. **camelCase hook 名**（`beforeModel` 不是 `before_model`），
 *      跟 lumen 既有 TypeScript 风格对齐。
 *   5. **兼容既有 `HookRegistry`**。P19.0 引入 middleware 不破坏
 *      已有 hook 路径；middleware 在 hook 之外加 5 个显式调用点
 *      （beforeModel / afterModel / wrapModelCall / wrapToolCall /
 *      state 注入）。
 *
 * 5 个 hook 语义:
 *   - `beforeModel(messages, ctx)`: 模型调用**前**改 messages。
 *     返回新 messages（不修改原数组）。可用于 plan 模式注入
 *     提示词 / context 压缩。
 *   - `afterModel(response, ctx)`: 模型调用**后**改 response。
 *     返回新 AssistantMessage。用于 reflection 追加 confidence
 *     token / 拦截 `<plan>` 标记。
 *   - `wrapModelCall(messages, call, ctx)`: 包裹 model call
 *     本身。call 是 `(msgs) => Promise<response>`，wrapper 可以
 *     决定调用、改输入、改输出、加 caching / retry / fallback。
 *   - `wrapToolCall(tool, call, ctx)`: 包裹单个 tool call。
 *     call 是 `() => Promise<ToolResult>`。可用于 ToolRisk
 *     三档 enforce（`safe` / `approval-required` / `dangerous`，
 *     P19.0 + SECURITY.md action item）。
 *   - `stateSchema`: 声明 middleware 自己的 state 切片（Zod）。
 *     Agent.run 启动时把所有 middleware 的 state 合并到 root
 *     state 字典（namespace by `name`），跑完不写回。
 *
 * 4-framework 对齐（CLAUDE.md rule 16，P19-DESIGN.md §1.3）:
 *   - LangChain 1.0 (2025-10-17 GA): 强制 `class extends
 *     AgentMiddleware`、snake_case hook 名。Lumen 用
 *     **interface + function + camelCase**，避免 class 继承
 *     摩擦（CLAUDE.md rule 14：抽象类 ≥ 2 个非 wrapper 实现才
 *     保留）。
 *   - LangGraph 1.0: 无显式 middleware，节点 + Command
 *     替代。Lumen **不**对齐 LangGraph 节点范式（保留 loop）。
 *   - OpenClaw / Hermes: 都没有 AgentMiddleware 概念。
 *
 * State 隔离 (P19-DESIGN.md §1.2):
 *   - 每个 middleware 通过 `stateSchema` 声明自己的 Zod schema。
 *   - Agent.run 启动时按 `name` namespace 合并到 root state
 *     字典 `state[name]`。
 *   - 中间件**只能**写自己的 `state[name]` 切片；写别的
 *     middleware 的 slice 抛 `ConfigError`（runtime 检查，
 *     防偷加字段）。
 *   - run 结束不写回磁盘（持久化由 BaseMemoryStore 单独管）。
 *
 * 错误处理:
 *   - middleware 内部 throw → Agent.run 捕获并 dispatch
 *     `kind: 'error'` hook + 抛 `MiddlewareError extends AgentError`。
 *   - 错误信息带 middleware `name` 便于 debug。
 *
 * 用法 (P19.0.3 factory):
 *   ```typescript
 *   const agent = createAgent({
 *     model: 'gpt-4o-mini',
 *     tools,
 *     middleware: [
 *       createPlanMiddleware({ mode: 'auto' }),
 *       createInlineReflectionMiddleware(),
 *     ],
 *   })
 *   ```
 *
 * 5 段示例见 `docs/P19-DESIGN.md` §1.4。PlanMiddleware 完整示例
 * 见 §2.3。
 */

import type { ZodType } from 'zod'
import { z } from 'zod'

import { AgentError } from '../errors/index.js'
import type { AssistantMessage, Message, ToolCall, ToolResult } from '../message/index.js'

/**
 * Per-invocation context for a middleware hook. Carries session metadata
 * and the merged middleware state slice (see P19-DESIGN.md §1.2).
 *
 * `state` is a flat dictionary keyed by middleware `name`. A middleware
 * may only read/write its own slice (`state[this.name]`); writing any
 * other key throws `ConfigError` at runtime (P19.0 defensive check,
 * P19-DESIGN.md §1.2 last bullet).
 */
export interface MiddlewareContext {
  /** Session id (UUID v4). Stable across the run. */
  readonly sessionId: string
  /** 1-based iteration counter (0 for hooks called before the loop body). */
  readonly iteration: number
  /** Wall-clock ms since the run started. */
  readonly startedAt: number
  /**
   * Merged middleware state. Each middleware owns `state[this.name]`.
   * The shape of `state[this.name]` is defined by the middleware's
   * `stateSchema`.
   */
  readonly state: Readonly<Record<string, unknown>>
  /** Abort signal. Middleware can check `signal.aborted`. */
  readonly signal?: AbortSignal
}

/**
 * Read-only snapshot of the middleware state, plus a typed writer that
 * only permits the middleware to update its own slice.
 *
 * Why a writer instead of free-form `state` mutation: lumen rule 12
 * mandates that middleware state is append-only and namespaced. The
 * `set` callback is the only legal mutation surface; the `state`
 * snapshot is the only legal read surface.
 */
export interface MiddlewareStateView<TState> {
  /** Current value of this middleware's state slice. */
  readonly current: TState
  /**
   * Replace this middleware's state slice. The new value is parsed
   * against `stateSchema` first; on parse failure the agent throws
   * `MiddlewareError` and aborts the run.
   */
  set(next: TState): void
}

/**
 * `beforeModel` hook signature.
 *
 * Receives the messages about to be sent to the model. Must return
 * a new messages array (the input is frozen by convention; mutating
 * it is undefined behaviour). Used to:
 *   - inject plan-mode system prompts
 *   - summarize / compress history before the model call
 *   - add retrieved context from memory
 */
export type BeforeModelHook = (
  messages: ReadonlyArray<Message>,
  ctx: MiddlewareContext,
) => Promise<ReadonlyArray<Message>> | ReadonlyArray<Message>

/**
 * `afterModel` hook signature.
 *
 * Receives the model's response. Must return a new AssistantMessage
 * (or the same one). Used to:
 *   - parse `<plan id="x">` tags and set state.plan
 *   - append a `[confidence: 0.X]` token (inline reflection)
 *   - redact secrets from the response before persistence
 */
export type AfterModelHook = (
  response: AssistantMessage,
  ctx: MiddlewareContext,
) => Promise<AssistantMessage> | AssistantMessage

/**
 * `wrapModelCall` hook signature.
 *
 * Wraps the model call itself. The default call signature is
 * `(messages) => Promise<AssistantMessage>`. The middleware can:
 *   - call `call(messages)` zero or more times
 *   - mutate `messages` before calling
 *   - retry on `ProviderError`
 *   - fall back to a secondary provider
 *   - cache responses
 *
 * If `wrapModelCall` is omitted, the agent calls the provider
 * directly. This is the strongest extension point — anything that
 * changes "how the model is called" goes here.
 */
export type WrapModelCall = (
  messages: ReadonlyArray<Message>,
  call: (messages: ReadonlyArray<Message>) => Promise<AssistantMessage>,
  ctx: MiddlewareContext,
) => Promise<AssistantMessage>

/**
 * `wrapToolCall` hook signature.
 *
 * Wraps a single tool dispatch. The default call signature is
 * `() => Promise<ToolResult>`. The middleware can:
 *   - enforce ToolRisk (`safe` / `approval-required` / `dangerous`)
 *   - sandbox path checks (DefaultSandbox cross-tool, P19.0 + rule 18)
 *   - retry on `ToolError`
 *   - cache results
 *
 * If `wrapToolCall` is omitted, the agent calls `dispatchToolCall`
 * directly. ToolRisk enforcement MUST be a `wrapToolCall` (CLAUDE.md
 * rule 17 — P19.0 wire-up prerequisite).
 */
export type WrapToolCall = (
  toolCall: ToolCall,
  call: () => Promise<ToolResult>,
  ctx: MiddlewareContext,
) => Promise<ToolResult>

/**
 * The AgentMiddleware contract.
 *
 * A middleware is a plain object literal (not a class). It declares:
 *   - `name`: required stable identifier. Used as the state namespace
 *     key and in error messages. **No two middleware may share a name**
 *     in the same agent — `createAgent` throws `ConfigError` on
 *     duplicate `name` at construction time.
 *   - `stateSchema?`: optional Zod schema for this middleware's
 *     state slice. The default state is `z.unknown()` (untyped).
 *     P19.0 only requires the schema; P19.1 / P19.2 will start
 *     using it.
 *   - 0..4 hooks. At least one hook is required for a middleware
 *     to be useful; `createAgent` will accept an all-options
 *     middleware (lint check is not enforced; the runtime is a
 *     no-op pass-through).
 *
 * Implementations are plain objects (`const X: AgentMiddleware = {…}`)
 * or factory functions returning them (`createX(): AgentMiddleware`).
 * Both forms are first-class — see `createPlanMiddleware` /
 * `createInlineReflectionMiddleware` for the factory pattern
 * (P19.0.3 + P19.1.1 + P19.2.2).
 */
export interface AgentMiddleware<TState = unknown> {
  /** Stable identifier. Required. */
  readonly name: string
  /** Optional Zod schema for the middleware's state slice. */
  readonly stateSchema?: ZodType<TState>
  /** Optional: pre-process messages before the model call. */
  readonly beforeModel?: BeforeModelHook
  /** Optional: post-process the model response. */
  readonly afterModel?: AfterModelHook
  /** Optional: wrap the model call itself. */
  readonly wrapModelCall?: WrapModelCall
  /** Optional: wrap a single tool dispatch. */
  readonly wrapToolCall?: WrapToolCall
}

/**
 * Validated, parsed middleware config produced by {@link parseMiddleware}.
 * Internal to the agent loop; consumers should construct middleware via
 * the factory helpers (`createPlanMiddleware` etc.) instead of building
 * this directly.
 */
export interface ParsedMiddleware<TState = unknown> {
  readonly raw: AgentMiddleware<TState>
  readonly name: string
  readonly stateSchema: ZodType<TState>
  readonly initialState: TState
}

/**
 * Error thrown when a middleware violates a lumen rule (P19.0 wire-up
 * prerequisite). Carries the offending middleware `name` for debug.
 *
 * Extends `AgentError` so the existing `error.ts` taxonomy catches
 * it (P9.1 typed error contract). The `kind: 'middleware'` discriminator
 * lets tests assert the source without parsing strings.
 */
export class MiddlewareError extends AgentError {
  public readonly middlewareName: string

  public constructor(message: string, middlewareName: string, cause?: unknown) {
    super(`[middleware:${middlewareName}] ${message}`, { cause })
    this.name = 'MiddlewareError'
    this.middlewareName = middlewareName
  }
}

/**
 * Validate and parse a list of middleware at agent-construction time.
 * Called by `createAgent` (P19.0.3) and by `Agent`'s constructor when
 * `config.middleware` is provided (P19.0.2).
 *
 * Checks (all throw `MiddlewareError`):
 *   1. `name` is a non-empty string.
 *   2. No duplicate `name` within the same list.
 *   3. `stateSchema` defaults to `z.unknown()` if omitted.
 *
 * Returned `ParsedMiddleware[]` is what the agent loop iterates on
 * the hot path — it is built once at construction time, not on
 * every `run()` call.
 *
 * @param middleware - the raw middleware list, in registration order.
 * @returns the validated + default-filled list.
 */
export const parseMiddleware = <TState = unknown>(
  middleware: ReadonlyArray<AgentMiddleware<TState>>,
): ReadonlyArray<ParsedMiddleware<TState>> => {
  const seen = new Set<string>()
  return middleware.map((raw, i) => {
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
      throw new MiddlewareError(
        `middleware[${i}].name must be a non-empty string`,
        String(raw.name ?? '<missing>'),
      )
    }
    if (seen.has(raw.name)) {
      throw new MiddlewareError(`duplicate middleware name "${raw.name}" at index ${i}`, raw.name)
    }
    seen.add(raw.name)
    // `stateSchema` is optional. Default to `z.unknown()` so the
    // middleware is allowed to read/write any shape; P19.1 / P19.2
    // will start shipping typed schemas. The runtime parses
    // `set()` calls against this schema, but `z.unknown()` accepts
    // everything, so the default is a no-op.
    return {
      raw,
      name: raw.name,
      // Use `z.unknown()` as the default schema. P19.0 keeps the
      // runtime tolerant; P19.1 / P19.2 will require typed schemas
      // for their wire-up.
      stateSchema: (raw.stateSchema ?? z.unknown()) as ZodType<TState>,
      initialState: undefined as TState,
    }
  })
}
