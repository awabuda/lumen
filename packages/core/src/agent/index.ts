/**
 * The Agent — the orchestration kernel.
 *
 * Responsibilities (and ONLY these):
 *   1. Run a conversation loop until the model emits a final assistant
 *      message (no tool calls).
 *   2. Dispatch tool calls into the {@link ToolRegistry}.
 *   3. Enforce iteration / token / cost / time budgets.
 *   4. Stream events for observability.
 *   5. Emit hooks for observers.
 *   6. Persist conversation into {@link BaseMemoryStore} (if provided).
 *
 * Explicit non-responsibilities (the agent does NOT do these):
 *   - Know about any specific provider
 *   - Know about any specific tool
 *   - Format output for a UI (that's the consumer's job)
 *   - Manage credentials (that's the provider's job)
 *
 * This is the **composition root's** primary collaborator. The CLI builds
 * an Agent with a concrete provider, concrete tools, and (optionally) a
 * memory store, then calls `agent.run(userMessage)`.
 *
 * Extending the loop: do NOT subclass Agent. Instead, register hooks.
 * The hook system covers ~all the customization you'll need.
 */

import type { LumenConfig } from '@lumen/config'
import { Budget } from '../budget/index.js'
import {
  AbortError,
  MaxIterationsExceededError,
  ProviderError,
  ToolError,
} from '../errors/index.js'
import { HookRegistry } from '../hooks/index.js'
import { type BaseLogger, ConsoleLogger } from '../logging/index.js'
import type { BaseMemoryStore } from '../memory/index.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  ToolCall,
  ToolResult,
} from '../message/index.js'
import type { BaseProvider } from '../message/provider.js'
import type { ToolRegistry } from '../tools/index.js'
import {
  type MiddlewareContext,
  MiddlewareError,
  type MiddlewareStateView,
  type ParsedMiddleware,
  getAgentMiddleware,
} from './middleware.js'

export interface AgentConfig {
  /** The LLM provider to call. Required. */
  readonly provider: BaseProvider
  /** Tools the agent may invoke. Required. */
  readonly tools: ToolRegistry
  /** Memory store. Optional — if omitted, runs are ephemeral. */
  readonly memory?: BaseMemoryStore
  /** Hook registry. Optional — defaults to empty. */
  readonly hooks?: HookRegistry
  /** Loaded Lumen config. Optional — sensible defaults are used if omitted. */
  readonly config?: LumenConfig
  /** Model identifier to pass to the provider. Defaults to `config.defaultModel`. */
  readonly model?: string
  /** System prompt. Defaults to a minimal neutral prompt. */
  readonly systemPrompt?: string
  /** Working directory (passed to tools via ToolContext). */
  readonly cwd?: string
  /** Logger. Defaults to a no-op ConsoleLogger. */
  readonly logger?: BaseLogger
}

export interface AgentRunOptions {
  /** Initial user message. */
  readonly userMessage: string
  /** Optional session id; a new one is generated if omitted. */
  readonly sessionId?: string
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal
  /**
   * Maximum number of agent iterations (model->tool->model cycles).
   * Overrides the config default.
   */
  readonly maxIterations?: number
  /**
   * If true, allow one extra iteration after the budget is exceeded,
   * giving the model a chance to emit a final answer rather than being
   * cut off mid-thought.
   */
  readonly oneTurnGraceCall?: boolean
  /**
   * P20.4.2: resume from a previously saved checkpoint. When
   * provided, the agent loop re-enters with the checkpoint's
   * `messages` as the conversation history (the `userMessage`
   * option is ignored). The session id from the checkpoint is
   * reused unless `sessionId` is explicitly given.
   */
  readonly resumeFrom?: import('./checkpoint.js').AgentCheckpoint
  /**
   * P20.4.2: when the loop throws (abort, max iterations, budget
   * exceeded), the latest message history is auto-saved as a
   * checkpoint under this store. Pass `InMemoryCheckpointStore`
   * for tests; pass a SQLite-backed store for cross-process
   * persistence. The store is **not** read on resume — use
   * `resumeFrom` for that.
   */
  readonly checkpointStore?: import('./checkpoint.js').BaseCheckpointStore
  /**
   * P21.0.1: how often to save an in-progress checkpoint during
   * the run. Defaults to 1 (every step). Must be a positive integer.
   * The terminal success/error snapshot is always attempted.
   *
   * Only takes effect when `checkpointStore` is also set.
   */
  readonly checkpointInterval?: number
}

export interface AgentRunResult {
  readonly sessionId: string
  readonly finalMessage: AssistantMessage
  readonly iterations: number
  readonly messages: ReadonlyArray<Message>
}

/**
 * Events emitted by {@link Agent.streamRun}. The TUI consumes these to
 * update the screen in real time. Each event has a discriminated `type`
 * field so consumers can switch on it without runtime guessing.
 *
 * Event ordering, by example:
 *
 *   { type: 'run:start', sessionId, userMessage }
 *   { type: 'text:start', iteration: 1 }
 *   { type: 'text:delta', delta: 'Hel' }      // 0..N times
 *   { type: 'text:delta', delta: 'lo' }
 *   { type: 'text:end', content: 'Hello' }     // finalized text of this step
 *   { type: 'tool:start', toolCall }            // only if model called tools
 *   { type: 'tool:end', toolCall, result, durationMs }
 *   { type: 'step:end', iteration, finalMessage }
 *   { type: 'text:start', iteration: 2 }       // next step
 *   ...
 *   { type: 'run:end', finalMessage, iterations, messages }
 *
 * On error, the final event is `{ type: 'error', error }` and the
 * generator terminates (the result promise rejects).
 */
export type RunEvent =
  | { type: 'run:start'; sessionId: string; userMessage: string }
  | { type: 'text:start'; iteration: number }
  | { type: 'text:delta'; delta: string }
  | { type: 'text:end'; content: string; iteration: number }
  | { type: 'tool:start'; toolCall: ToolCall; iteration: number }
  | {
      type: 'tool:end'
      toolCall: ToolCall
      result: ToolResult
      durationMs: number
      iteration: number
    }
  | { type: 'step:end'; iteration: number; message: AssistantMessage }
  | { type: 'run:end'; finalMessage: AssistantMessage; iterations: number }
  | { type: 'error'; error: Error }

/** Default neutral system prompt. Override via {@link AgentConfig.systemPrompt}. */
const DEFAULT_SYSTEM_PROMPT = `You are Lumen, a self-improving AI agent.
You may use tools to gather information and take actions.
Prefer minimal, surgical actions. Explain your reasoning before tool calls.
When you have a final answer, state it directly.`

/**
 * Merge a JSON-arguments delta into an existing arguments object.
 *
 * OpenAI-style streams send tool-call arguments as a series of JSON
 * fragments; we concatenate them as raw strings until the call is
 * complete, then parse. This helper returns a record whose `__raw__`
 * key holds the concatenated delta when we know parsing is unsafe yet.
 */
const mergeArgs = (
  existing: Record<string, unknown>,
  delta: string | undefined,
): Record<string, unknown> => {
  if (delta === undefined || delta.length === 0) return existing
  const rawKey = '__raw__'
  const prior = typeof existing[rawKey] === 'string' ? (existing[rawKey] as string) : ''
  return { ...existing, [rawKey]: prior + delta }
}

/** Cryptographically-random ID for sessions (uses Web Crypto, available in Node 20+). */
const newSessionId = (): string => {
  // Node 20 has globalThis.crypto.randomUUID
  return (globalThis as { crypto: { randomUUID: () => string } }).crypto.randomUUID()
}

/**
 * Persist one checkpoint without letting storage failure change the run result.
 *
 * Step saves respect `interval`; terminal saves (`success` / `error`) pass
 * `force: true`. Error snapshots use a distinct id so the last completed
 * `in_progress` checkpoint remains available for auto-resume.
 */
const saveCheckpointBestEffort = async (input: {
  readonly logger: BaseLogger
  readonly store?: import('./checkpoint.js').BaseCheckpointStore
  readonly sessionId: string
  readonly finalMessage: AssistantMessage
  readonly iterations: number
  readonly messages: ReadonlyArray<Message>
  readonly interval: number
  readonly outcome: 'in_progress' | 'success' | 'error'
  readonly force?: boolean
}): Promise<void> => {
  if (!input.store) return
  if (!input.force) {
    if (!Number.isInteger(input.interval) || input.interval < 1) return
    if (input.iterations % input.interval !== 0) return
  }

  try {
    const { checkpointFromRun } = await import('./checkpoint.js')
    const checkpoint = checkpointFromRun({
      sessionId: input.sessionId,
      finalMessage: input.finalMessage,
      iterations: input.iterations,
      messages: input.messages,
    })
    const terminalError = input.outcome === 'error'
    await input.store.save({
      ...checkpoint,
      ...(terminalError
        ? {
            id: `${checkpoint.id}-error-${checkpoint.createdAt}`,
          }
        : {}),
      outcome: input.outcome,
    })
  } catch (err) {
    // P23.5 (fix #7) — checkpoint persistence is best-effort
    // and must never replace the agent result or the original
    // run error. But pre-P23.5 the catch block silently
    // swallowed the failure: a user resuming after a crash had
    // no way to tell whether the run crashed, the checkpoint
    // save crashed, or both. Log via the agent logger at
    // `warn` level with structured context so the failure is
    // visible in `hermes logs` / `agent.log` without disrupting
    // the run. We log rather than throw so the best-effort
    // contract is preserved.
    input.logger.warn('checkpoint save failed; run continues without persistence', {
      sessionId: input.sessionId,
      iterations: input.iterations,
      outcome: input.outcome,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : 'UnknownError',
    })
  }
}

export class Agent {
  private readonly provider: BaseProvider
  private readonly tools: ToolRegistry
  private readonly memory?: BaseMemoryStore
  private readonly hooks: HookRegistry
  private readonly model: string
  private readonly systemPrompt: string
  private readonly cwd: string
  private readonly logger: BaseLogger
  // P23.1: scratch slot for the run/streamRun adapters. Set by
  // `executeLoop` on success so the caller can read the final
  // AgentRunResult without us having to thread it through the
  // async-generator's return value (TypeScript generators cannot
  // be awaited, only `for await`-ed). Reset to `undefined` on entry.
  private lastRunResult: AgentRunResult | undefined

  constructor(config: AgentConfig) {
    this.provider = config.provider
    this.tools = config.tools
    this.memory = config.memory
    this.hooks = config.hooks ?? new HookRegistry()
    this.model = config.model ?? config.config?.defaultModel ?? 'gpt-4o-mini'
    this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
    this.cwd = config.cwd ?? process.cwd()
    this.logger = config.logger ?? new ConsoleLogger({ component: 'agent' })
  }

  /**
   * Run the agent loop to completion on a single user message.
   * Returns the final assistant message plus the full message history.
   */
  public async run(options: AgentRunOptions): Promise<AgentRunResult> {
    // P23.1: thin adapter — the shared loop lives in `executeLoop`. The
    // 'sync' mode discards the yielded events; the only thing the caller
    // cares about is the final AgentRunResult. Bug #1 (streamRun bypassing
    // middleware) is fixed in P23.0 once `executeLoop` is the only loop
    // path. Bug #3 (run/streamRun duplication) is fixed by this refactor.
    for await (const _ev of this.executeLoop(options, 'sync')) {
      // events go to HookRegistry only in sync mode
    }
    // executeLoop sets `this.lastRunResult` on success. The throw path
    // skips this return, so reaching this line means we have a result.
    if (this.lastRunResult === undefined) {
      throw new Error('Agent.run: executeLoop returned without setting lastRunResult')
    }
    return this.lastRunResult!
  }

  /**
   * Run the agent loop, yielding {@link RunEvent}s as work progresses.
   * This is the streaming-friendly counterpart to {@link run}.
   *
   * The generator yields events in this rough order per step:
   *   text:start → text:delta* → text:end → tool:start* → tool:end* → step:end
   *
   * For providers that don't support true streaming, the entire text
   * arrives as a single `text:delta` followed by `text:end`. This is
   * fine — the TUI doesn't care, it just renders whatever it gets.
   *
   * On the final step, the `run:end` event carries the final assistant
   * message and total iteration count.
   *
   * Error handling: if the loop throws (abort, budget, etc.), the
   * generator yields one `error` event and then returns. Callers that
   * need the result should still await the result promise returned by
   * `toResult()` if they used the helper, or catch the throw if they
   * consumed events directly.
   */
  public async *streamRun(
    options: AgentRunOptions,
  ): AsyncGenerator<RunEvent, AgentRunResult, void> {
    // P23.1: thin adapter. The shared loop lives in `executeLoop`. The
    // 'stream' mode yields the events to the caller as they are produced.
    // The provider's `.stream()` is invoked by `executeLoop` so the
    // `applyBeforeModel` / `applyAfterModel` / `wrapModelCall` middlewares
    // are exercised in stream mode too — bug #1 fix lives in P23.0.
    for await (const ev of this.executeLoop(options, 'stream')) {
      if (ev !== undefined) yield ev
    }
    if (this.lastRunResult === undefined) {
      throw new Error('Agent.streamRun: executeLoop returned without setting lastRunResult')
    }
    return this.lastRunResult!
  }

  /**
   * Convenience: stream the response. Wraps `run()` and yields the
   * provider's stream events as they arrive, but only for the *last*
   * assistant turn (intermediate turns are awaited in full because their
   * tool calls need to be dispatched).
   */
  public async *stream(
    options: AgentRunOptions,
  ): AsyncGenerator<
    StreamEvent | { type: 'tool_complete'; toolCall: ToolCall; result: ToolResult },
    void,
    void
  > {
    // Kept for backward compatibility; the TUI now uses streamRun().
    for await (const ev of this.streamRun(options)) {
      if (ev.type === 'text:delta') {
        yield { type: 'content_delta', delta: ev.delta }
      } else if (ev.type === 'tool:end') {
        yield { type: 'tool_complete', toolCall: ev.toolCall, result: ev.result }
      } else if (ev.type === 'run:end') {
        yield { type: 'message_complete', message: ev.finalMessage }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * P23.1: shared agent loop used by both `run()` (sync) and
   * `streamRun()` (streaming). The two public entry points are thin
   * adapters over this generator.
   *
   * Behaviour:
   * - **Init** (lines 1-31 of the original `run()`/`streamRun()`) is
   *   identical in both modes; the loop runs once with a
   *   `mode: 'sync' | 'stream'` flag.
   * - **Events** are dispatched in two places per cycle:
   *   - In `sync` mode, every "lifecycle" event (run:start, step:start,
   *     message:append, step:end, run:end, error, tool:call,
   *     tool:result) goes to `this.hooks.dispatch`.
   *   - In `stream` mode, the same lifecycle events go to hooks AND
   *     to the `RunEvent` channel via `yield`. The `text:start`,
   *     `text:delta`, `text:end`, `tool:start`, `tool:end` events
   *     are stream-only and are only yielded in stream mode.
   * - **Provider call** is `callProviderWithMiddleware` in sync mode
   *   and `provider.stream(...)` in stream mode. The middleware
   *   `wrapModelCall` / `beforeModel` / `afterModel` hooks are
   *   invoked identically in both modes — bug #1 fix lives in P23.0
   *   which uses this shared loop.
   * - **Tool dispatch** is `callToolWithMiddleware` in sync mode
   *   and `dispatchToolCall` in stream mode. Bug #1's other half
   *   (the missing `wrapToolCall` hook in stream mode) is also
   *   fixed in P23.0.
   * - The terminal `applyAfterRun` is invoked in sync mode only
   *   (matches the pre-refactor behaviour; P23.0 may add it to
   *   stream mode but for this commit we keep behaviour identical).
   *
   * Returns the final `AgentRunResult` (typed via `this.lastRunResult`
   * for the caller to read; the generator's own return value is
   * reserved for the `stream` channel and is also `undefined`).
   */
  private async *executeLoop(
    options: AgentRunOptions,
    mode: 'sync' | 'stream',
  ): AsyncGenerator<RunEvent | undefined, void, void> {
    // P20.4.2: when resumeFrom is provided, reuse the checkpoint's
    // sessionId and skip the fresh "system + user" seed. The agent
    // loop continues with the checkpoint's messages as the
    // conversation history; the userMessage option is ignored.
    const checkpoint = options.resumeFrom
    const sessionId = options.sessionId ?? checkpoint?.sessionId ?? newSessionId()
    const signal = options.signal
    const maxIterations = options.maxIterations ?? 50
    const oneTurnGrace = options.oneTurnGraceCall ?? true
    const checkpointInterval = options.checkpointInterval ?? 1
    if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
      throw new RangeError('checkpointInterval must be a positive integer')
    }

    if (signal?.aborted) {
      throw new AbortError('pre-aborted')
    }

    const messages: Message[] = checkpoint
      ? [...checkpoint.messages]
      : [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: options.userMessage },
        ]

    const budget = new Budget({
      tokens: this.provider.capabilities.maxContextTokens,
    })

    this.lastRunResult = undefined

    if (this.memory) {
      await this.memory.createSession({ id: sessionId, title: options.userMessage.slice(0, 80) })
      for (const m of messages) {
        await this.persistMessage(sessionId, m)
      }
    }

    let iterations = 0
    let lastMessage: AssistantMessage = { role: 'assistant', content: '', toolCalls: [] }
    const middleware = getAgentMiddleware(this)
    const middlewareState = this.createMiddlewareState(middleware)
    // P23.3 — typed mutation surface for middleware state slices.
    // Built once per run; the `set` callbacks close over
    // `middlewareState` so writes persist across iterations.
    const stateView = this.buildStateView(middleware, middlewareState)

    // P23.1: emit a run:start event. Hooks always; the run-event
    // channel only in stream mode.
    await this.hooks.dispatch(
      { kind: 'run:start', sessionId, userMessage: options.userMessage },
      { sessionId, iteration: 0, startedAt: Date.now() },
    )
    if (mode === 'stream') {
      yield { type: 'run:start', sessionId, userMessage: options.userMessage }
    }

    try {
      while (true) {
        if (signal?.aborted) {
          throw new AbortError('signal aborted')
        }
        iterations += 1
        if (iterations > maxIterations) {
          throw new MaxIterationsExceededError(maxIterations)
        }
        const middlewareControl = { continueAfterModel: false }

        await this.hooks.dispatch(
          { kind: 'step:start', iteration: iterations },
          { sessionId, iteration: iterations, startedAt: Date.now() },
        )
        if (mode === 'stream') yield { type: 'text:start', iteration: iterations }

        const ctx = this.middlewareContext(
          {
            sessionId,
            iteration: iterations,
            startedAt: Date.now(),
            state: middlewareState,
            control: middlewareControl,
            signal,
          },
          stateView,
        )

        // Model call. P23.0 unifies the sync and stream paths so
        // `applyBeforeModel` and `applyAfterModel` run in both modes
        // (bug #1: pre-P23.0 only the sync path invoked them; the
        // stream path went straight to `provider.stream()`). The
        // `wrapModelCall` middleware is **still** sync-only because
        // its signature is `(input, next, ctx) => Promise<message>` —
        // stream support would require a new generator-aware
        // contract. P23.0 documents the gap; P24 will add a
        // `wrapModelStream` middleware that operates on the
        // `AsyncGenerator<StreamEvent, message>` shape.
        const modelMessages = await this.applyBeforeModel(middleware, messages, {
          ...ctx,
          history: messages,
        })
        let responseMessage: AssistantMessage
        if (mode === 'sync') {
          const assistantMessage = await this.callProviderWithMiddleware(
            middleware,
            modelMessages,
            budget,
            signal,
            // P23.4 — wrapModelCall also sees history (the
            // pre-model-call messages).
            { ...ctx, history: messages },
          )
          // P23.4 — attach the post-response history so middleware
          // (notably reflection) can read signals across the whole
          // run, not just the single turn.
          responseMessage = await this.applyAfterModel(middleware, assistantMessage, {
            ...ctx,
            history: [...messages, assistantMessage],
          })
        } else {
          // P23.0: stream path now respects `applyBeforeModel` (the
          // `modelMessages` returned above is what we pass to the
          // stream) and runs `applyAfterModel` once the stream
          // completes. The deltas are yielded via the inner
          // generator's `yield`; the assembled message comes back as
          // the inner generator's return value.
          const inner: AsyncGenerator<RunEvent, AssistantMessage, void> =
            this.runStreamModelCallInline(modelMessages, signal, iterations, budget)
          let lastValue: AssistantMessage | undefined
          while (true) {
            const next = await inner.next()
            if (next.done) {
              lastValue = next.value
              break
            }
            yield next.value
          }
          // P23.4 — same history-attach on the stream path.
          if (lastValue === undefined) {
            throw new ProviderError(`Provider ${this.provider.id} stream yielded no events`, {
              providerId: this.provider.id,
              retryable: true,
            })
          }
          responseMessage = await this.applyAfterModel(middleware, lastValue, {
            ...ctx,
            history: [...messages, lastValue],
          })
        }

        if (responseMessage.usage) {
          budget.addTokens(responseMessage.usage.totalTokens)
        }

        messages.push(responseMessage)
        lastMessage = responseMessage
        await this.hooks.dispatch(
          { kind: 'message:append', message: responseMessage },
          { sessionId, iteration: iterations, startedAt: Date.now() },
        )
        if (this.memory) {
          await this.persistMessage(sessionId, responseMessage)
        }

        // If the model didn't ask for tools, the step is complete —
        // unless a middleware explicitly asked the loop to continue
        // (P19.1 auto plan -> act), in which case we save the
        // checkpoint and `continue` to the next iteration. The
        // step:end hook + run-event are emitted either way.
        if (responseMessage.toolCalls.length === 0) {
          await this.hooks.dispatch(
            { kind: 'step:end', iteration: iterations, message: responseMessage },
            { sessionId, iteration: iterations, startedAt: Date.now() },
          )
          if (mode === 'stream') {
            yield { type: 'step:end', iteration: iterations, message: responseMessage }
          }
          await saveCheckpointBestEffort({
            logger: this.logger,
            store: options.checkpointStore,
            sessionId,
            finalMessage: lastMessage,
            iterations,
            messages,
            interval: checkpointInterval,
            outcome: 'in_progress',
          })
          if (middlewareControl.continueAfterModel) {
            continue
          }
          break
        }

        if (budget.isExceeded() && !(oneTurnGrace && iterations === maxIterations)) {
          budget.check()
        }

        // Dispatch each tool call. P23.0 unifies sync and stream
        // modes on the same `callToolWithMiddleware` path so the
        // `wrapToolCall` middleware hook fires in both modes (bug
        // #1: pre-P23.0 the stream path went straight to
        // `dispatchToolCall` and skipped the wrapper). The `sessionId`
        // is threaded so the tool can scope audit logs and
        // per-session resources (bug #6: pre-P23.0 it was always
        // `''`).
        const results: ToolResult[] = []
        for (const call of responseMessage.toolCalls) {
          await this.hooks.dispatch(
            { kind: 'tool:call', toolCall: call },
            { sessionId, iteration: iterations, startedAt: Date.now() },
          )
          if (mode === 'stream') {
            yield { type: 'tool:start', toolCall: call, iteration: iterations }
          }
          const startedAt = Date.now()
          const result = await this.callToolWithMiddleware(middleware, call, signal, ctx, sessionId)
          const durationMs = Date.now() - startedAt
          await this.hooks.dispatch(
            { kind: 'tool:result', toolCall: call, result, durationMs },
            { sessionId, iteration: iterations, startedAt: Date.now() },
          )
          if (mode === 'stream') {
            yield {
              type: 'tool:end',
              toolCall: call,
              result,
              durationMs,
              iteration: iterations,
            }
          }
          results.push(result)
        }

        const toolMessage: Message = { role: 'tool', results }
        messages.push(toolMessage)
        if (this.memory) {
          await this.persistMessage(sessionId, toolMessage)
        }
        // step:end comes after tool dispatch so the UI can show the
        // full "thought → action → result" cycle in one screen frame.
        await this.hooks.dispatch(
          { kind: 'step:end', iteration: iterations, message: responseMessage },
          { sessionId, iteration: iterations, startedAt: Date.now() },
        )
        if (mode === 'stream') {
          yield { type: 'step:end', iteration: iterations, message: responseMessage }
        }
        await saveCheckpointBestEffort({
          logger: this.logger,
          store: options.checkpointStore,
          sessionId,
          finalMessage: lastMessage,
          iterations,
          messages,
          interval: checkpointInterval,
          outcome: 'in_progress',
        })
      }

      await this.hooks.dispatch(
        {
          kind: 'run:end',
          sessionId,
          finalMessage: lastMessage,
          iterations,
        },
        { sessionId, iteration: iterations, startedAt: Date.now() },
      )
      if (mode === 'stream') {
        yield { type: 'run:end', finalMessage: lastMessage, iterations }
      }

      const result: AgentRunResult = { sessionId, finalMessage: lastMessage, iterations, messages }
      // P23.0: `applyAfterRun` is now invoked in **both** sync and
      // stream modes (bug #1: pre-P23.0 the stream path skipped it,
      // so the `afterRun` hook never ran for `lumen run --stream` /
      // `lumen chat`). The hook signature is sync-only, so it
      // completes before the run-end event is yielded in stream
      // mode; the deltas-then-final pattern is preserved.
      await this.applyAfterRun(
        middleware,
        result,
        this.middlewareContext(
          {
            sessionId,
            iteration: iterations,
            startedAt: Date.now(),
            state: middlewareState,
            control: { continueAfterModel: false },
            signal,
          },
          stateView,
        ),
        // P23.4 — afterRun sees the full final history.
        messages,
      )

      await saveCheckpointBestEffort({
        logger: this.logger,
        store: options.checkpointStore,
        sessionId,
        finalMessage: lastMessage,
        iterations,
        messages,
        interval: checkpointInterval,
        outcome: 'success',
        force: true,
      })

      this.lastRunResult = result
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      const recoverable = err instanceof AbortError
      await this.hooks.dispatch(
        { kind: 'error', error, recoverable },
        { sessionId, iteration: iterations, startedAt: Date.now() },
      )
      if (mode === 'stream') yield { type: 'error', error }
      await saveCheckpointBestEffort({
        logger: this.logger,
        store: options.checkpointStore,
        sessionId,
        finalMessage: lastMessage,
        iterations,
        messages,
        interval: checkpointInterval,
        outcome: 'error',
        force: true,
      })
      throw err
    }
  }

  /**
   * P23.0: stream-mode model call. Reads the provider's stream
   * events and accumulates them into an `AssistantMessage`,
   * yielding `text:delta` / `text:end` events on the run-event
   * channel.
   *
   * P23.0 changes from P23.1:
   *  - `applyBeforeModel` is honoured upstream (the caller passes
   *    the modified `modelMessages`).
   *  - `applyAfterModel` is honoured downstream (the caller wraps
   *    the assembled message).
   *  - The `toolAcc` map key is the OpenAI `id` string instead of
   *    the integer index 0 (bug #10: pre-P23.0 all parallel
   *    tool-call deltas were collapsed into a single entry at
   *    index 0; the last one won and the rest were dropped).
   */
  private async *runStreamModelCallInline(
    messages: ReadonlyArray<Message>,
    signal: AbortSignal | undefined,
    iterations: number,
    budget: Budget,
  ): AsyncGenerator<RunEvent, AssistantMessage, void> {
    let partial: AssistantMessage = { role: 'assistant', content: '', toolCalls: [] }
    // P23.0: switch to `Map<string, ToolCall>` keyed by the OpenAI
    // `id` of the tool call delta. Pre-P23.0 the map was
    // `Map<number, ToolCall>` and `toolAcc.get(0)` / `set(0)` were
    // hard-coded, so parallel tool-call deltas collapsed into a
    // single entry (the last write won).
    const toolAcc = new Map<string, ToolCall>()
    let modelFromStream: string | undefined
    let finishFromStream: AssistantMessage['finishReason'] | undefined
    let usageFromStream: AssistantMessage['usage'] | undefined
    let lastContentAccumulated = ''

    try {
      for await (const ev of this.provider.stream(
        { messages, model: this.model },
        signal ? { signal } : undefined,
      )) {
        if (signal?.aborted) throw new AbortError('signal aborted')
        switch (ev.type) {
          case 'message_start':
            modelFromStream = ev.message.model
            break
          case 'content_delta':
            lastContentAccumulated += ev.delta
            partial = { ...partial, content: lastContentAccumulated }
            yield { type: 'text:delta', delta: ev.delta }
            break
          case 'tool_call_delta': {
            // P23.0: key by the OpenAI `id` (string), not the
            // hard-coded `0`. Providers that omit `id` fall back to
            // a stable per-delta synthetic key so a second call
            // for the same tool id still gets the right entry.
            const key = ev.id ?? `__index_${toolAcc.size}__`
            const existing = toolAcc.get(key) ?? {
              id: '',
              name: '',
              arguments: {} as Record<string, unknown>,
            }
            const merged: ToolCall = {
              id: ev.id ?? existing.id,
              name: ev.name ?? existing.name,
              arguments: mergeArgs(existing.arguments, ev.argumentsDelta),
            }
            toolAcc.set(key, merged)
            break
          }
          case 'tool_call_complete': {
            // P23.0: align with the delta path — key by the
            // tool call's `id` so multiple tool calls in the same
            // step coexist.
            const key = ev.toolCall.id ?? `__complete_${toolAcc.size}__`
            toolAcc.set(key, ev.toolCall)
            break
          }
          case 'message_complete':
            if (ev.message.content !== undefined) lastContentAccumulated = ev.message.content
            if (ev.message.model !== undefined) modelFromStream = ev.message.model
            if (ev.message.finishReason !== undefined) finishFromStream = ev.message.finishReason
            if (ev.message.usage !== undefined) usageFromStream = ev.message.usage
            if (ev.message.toolCalls.length > 0) {
              ev.message.toolCalls.forEach((tc, i) => toolAcc.set(tc.id ?? `__complete_${i}__`, tc))
            }
            break
          case 'reasoning_delta':
            partial = { ...partial, reasoning: (partial.reasoning ?? '') + ev.delta }
            break
          case 'error':
            throw ev.error
        }
      }
    } catch (err) {
      if (err instanceof AbortError) throw err
      throw new ProviderError(
        `Provider ${this.provider.id} stream failed: ${(err as Error).message ?? String(err)}`,
        { providerId: this.provider.id, cause: err, retryable: false },
      )
    }

    const toolCalls: ToolCall[] = toolAcc.size > 0 ? [...toolAcc.values()] : partial.toolCalls
    const assembled: AssistantMessage = {
      role: 'assistant',
      content: lastContentAccumulated.length > 0 ? lastContentAccumulated : partial.content,
      toolCalls,
      ...(modelFromStream !== undefined ? { model: modelFromStream } : {}),
      ...(finishFromStream !== undefined ? { finishReason: finishFromStream } : {}),
      ...(usageFromStream !== undefined ? { usage: usageFromStream } : {}),
      ...(partial.reasoning !== undefined ? { reasoning: partial.reasoning } : {}),
    }
    if (assembled.toolCalls.length === 0 && partial.toolCalls.length > 0) {
      assembled.toolCalls = partial.toolCalls
    }
    if (assembled.usage) budget.addTokens(assembled.usage.totalTokens)
    yield { type: 'text:end', content: assembled.content ?? '', iteration: iterations }
    return assembled
  }

  private createMiddlewareState(
    middleware: ReadonlyArray<ParsedMiddleware>,
  ): Record<string, unknown> {
    return Object.fromEntries(middleware.map((m) => [m.name, m.initialState]))
  }

  private middlewareContext(
    ctx: MiddlewareContext,
    stateView?: Readonly<Record<string, MiddlewareStateView<unknown>>>,
  ): MiddlewareContext {
    // P23.3 — attach the typed `stateView` map so middleware can
    // mutate their own state slices via `ctx.stateView[name].set()`
    // without resorting to the pre-P23.3 `state.plan = X` cast.
    return stateView === undefined ? ctx : { ...ctx, stateView }
  }

  /**
   * P23.3 — build a typed `stateView` map from the merged state
   * dictionary. Each entry's `set()` callback is closed over the
   * slice key and the owning middleware's `stateSchema`, so the
   * mutation is enforced to live within its own slice and be
   * schema-valid. Writes land in the same `middlewareState`
   * dictionary the snapshot reads from, so the change persists
   * across iterations.
   */
  private buildStateView(
    middleware: ReadonlyArray<ParsedMiddleware>,
    mergedState: Record<string, unknown>,
  ): Record<string, MiddlewareStateView<unknown>> {
    const out: Record<string, MiddlewareStateView<unknown>> = {}
    for (const m of middleware) {
      const key = m.name
      out[key] = {
        get current() {
          return mergedState[key]
        },
        set: (next: unknown) => {
          // Re-parse against the owning middleware's schema so a
          // shape violation aborts the run (P19 rule 12).
          const parsed = m.stateSchema.safeParse(next)
          if (!parsed.success) {
            throw new MiddlewareError(
              `stateView[${key}].set() rejected by stateSchema`,
              m.name,
              parsed.error,
            )
          }
          mergedState[key] = parsed.data
        },
      }
    }
    return out
  }

  private async applyBeforeModel(
    middleware: ReadonlyArray<ParsedMiddleware>,
    messages: ReadonlyArray<Message>,
    ctx: MiddlewareContext,
  ): Promise<ReadonlyArray<Message>> {
    let next = messages
    for (const m of middleware) {
      if (!m.raw.beforeModel) continue
      try {
        next = await m.raw.beforeModel(next, ctx)
      } catch (err) {
        throw new MiddlewareError('beforeModel failed', m.name, err)
      }
    }
    return next
  }

  private async applyAfterModel(
    middleware: ReadonlyArray<ParsedMiddleware>,
    response: AssistantMessage,
    ctx: MiddlewareContext,
  ): Promise<AssistantMessage> {
    let next = response
    for (const m of middleware) {
      if (!m.raw.afterModel) continue
      try {
        next = await m.raw.afterModel(next, ctx)
      } catch (err) {
        throw new MiddlewareError('afterModel failed', m.name, err)
      }
    }
    return next
  }

  private async callProviderWithMiddleware(
    middleware: ReadonlyArray<ParsedMiddleware>,
    messages: ReadonlyArray<Message>,
    budget: Budget,
    signal: AbortSignal | undefined,
    ctx: MiddlewareContext,
  ): Promise<AssistantMessage> {
    let call = async (input: ReadonlyArray<Message>): Promise<AssistantMessage> => {
      const response = await this.callProvider(input, budget, signal)
      return response.message
    }

    for (const m of [...middleware].reverse()) {
      if (!m.raw.wrapModelCall) continue
      const next = call
      call = async (input: ReadonlyArray<Message>): Promise<AssistantMessage> => {
        try {
          return await m.raw.wrapModelCall!(input, next, ctx)
        } catch (err) {
          throw new MiddlewareError('wrapModelCall failed', m.name, err)
        }
      }
    }

    return call(messages)
  }

  private async callToolWithMiddleware(
    middleware: ReadonlyArray<ParsedMiddleware>,
    toolCall: ToolCall,
    signal: AbortSignal | undefined,
    ctx: MiddlewareContext,
    sessionId: string,
  ): Promise<ToolResult> {
    let call = async (): Promise<ToolResult> => this.dispatchToolCall(toolCall, signal, sessionId)

    for (const m of [...middleware].reverse()) {
      if (!m.raw.wrapToolCall) continue
      const next = call
      call = async (): Promise<ToolResult> => {
        try {
          return await m.raw.wrapToolCall!(toolCall, next, ctx)
        } catch (err) {
          throw new MiddlewareError('wrapToolCall failed', m.name, err)
        }
      }
    }

    return call()
  }

  private async applyAfterRun(
    middleware: ReadonlyArray<ParsedMiddleware>,
    result: AgentRunResult,
    ctx: MiddlewareContext,
    // P23.4 — full final history. The result object already
    // carries `messages` (the same reference) but threading the
    // explicit argument lets the call site pass a richer ctx
    // (history already attached) without forcing every afterRun
    // implementation to read `result.messages`.
    history: ReadonlyArray<Message>,
  ): Promise<void> {
    for (const m of middleware) {
      if (!m.raw.afterRun) continue
      try {
        await m.raw.afterRun(result, { ...ctx, history })
      } catch (err) {
        throw new MiddlewareError('afterRun failed', m.name, err)
      }
    }
  }

  private async callProvider(
    messages: ReadonlyArray<Message>,
    _budget: Budget,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<BaseProvider['chat']>>> {
    try {
      return await this.provider.chat(
        {
          messages,
          model: this.model,
          // Pass the live tool descriptors so the provider can render
          // them into the wire format the model expects (OpenAI `tools`,
          // Anthropic `tools` with `input_schema`, etc.). Providers that
          // don't support tool use simply ignore this field.
          tools: this.tools.list(),
        },
        signal ? { signal } : undefined,
      )
    } catch (err) {
      if (err instanceof ProviderError) throw err
      throw new ProviderError(
        `Provider ${this.provider.id} failed: ${(err as Error).message ?? String(err)}`,
        {
          providerId: this.provider.id,
          cause: err,
          retryable: false,
        },
      )
    }
  }

  private async dispatchToolCall(
    call: ToolCall,
    signal: AbortSignal | undefined,
    sessionId: string,
  ): Promise<ToolResult> {
    const tool = this.tools.get(call.name)
    if (!tool) {
      return {
        toolCallId: call.id,
        isError: true,
        content: `Tool "${call.name}" is not registered`,
      }
    }
    try {
      const output = await tool.call(call.arguments, {
        cwd: this.cwd,
        signal: signal ?? new AbortController().signal,
        // P23.0: thread the real sessionId so the tool can scope
        // audit logs and per-session resources. Pre-refactor this
        // was hard-coded to `''` (bug #6 in bug.md).
        sessionId,
        log: {
          debug: (msg, meta) => this.logger.debug(msg, meta),
          info: (msg, meta) => this.logger.info(msg, meta),
          warn: (msg, meta) => this.logger.warn(msg, meta),
          error: (msg, meta) => this.logger.error(msg, meta),
        },
      })
      return {
        toolCallId: call.id,
        isError: false,
        content: typeof output === 'string' ? output : JSON.stringify(output),
        data:
          typeof output === 'object' && output !== null
            ? (output as Record<string, unknown>)
            : undefined,
      }
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          toolCallId: call.id,
          isError: true,
          content: err.message,
        }
      }
      return {
        toolCallId: call.id,
        isError: true,
        content: `Tool execution failed: ${(err as Error).message ?? String(err)}`,
      }
    }
  }

  private async persistMessage(sessionId: string, message: Message): Promise<void> {
    if (!this.memory) return
    const role = message.role
    let content = ''
    let toolName: string | undefined
    if (role === 'user' || role === 'system') {
      content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    } else if (role === 'assistant') {
      content = message.content ?? ''
      toolName =
        message.toolCalls.length > 0
          ? message.toolCalls.map((t: ToolCall) => t.name).join(',')
          : undefined
    } else if (role === 'tool') {
      content = message.results.map((r: ToolResult) => r.content ?? '').join('\n')
      toolName = message.results[0]?.toolCallId
    }
    await this.memory.appendMessage({ sessionId, role, content, toolName })
  }
}
