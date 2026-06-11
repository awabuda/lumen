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
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  ToolCall,
  ToolResult,
} from '../message/index.js'
import { BaseProvider } from '../message/provider.js'
import { ToolRegistry } from '../tools/index.js'
import { BaseMemoryStore } from '../memory/index.js'
import { BaseLogger, ConsoleLogger } from '../logging/index.js'
import { HookRegistry } from '../hooks/index.js'
import { Budget } from '../budget/index.js'
import { AbortError, MaxIterationsExceededError, ProviderError, ToolError } from '../errors/index.js'

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
  | { type: 'tool:end'; toolCall: ToolCall; result: ToolResult; durationMs: number; iteration: number }
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

export class Agent {
  private readonly provider: BaseProvider
  private readonly tools: ToolRegistry
  private readonly memory?: BaseMemoryStore
  private readonly hooks: HookRegistry
  private readonly model: string
  private readonly systemPrompt: string
  private readonly cwd: string
  private readonly logger: BaseLogger

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
    const sessionId = options.sessionId ?? newSessionId()
    const signal = options.signal
    const maxIterations = options.maxIterations ?? 50
    const oneTurnGrace = options.oneTurnGraceCall ?? true

    // Wire signal -> our abort tracking. The agent checks signal.aborted
    // at every loop boundary.
    if (signal?.aborted) {
      throw new AbortError('pre-aborted')
    }

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: options.userMessage },
    ]

    const budget = new Budget({
      tokens: this.provider.capabilities.maxContextTokens, // rough upper bound
    })

    await this.hooks.dispatch(
      { kind: 'run:start', sessionId, userMessage: options.userMessage },
      { sessionId, iteration: 0, startedAt: Date.now() },
    )

    // Persist initial messages if memory is available.
    if (this.memory) {
      await this.memory.createSession({ id: sessionId, title: options.userMessage.slice(0, 80) })
      for (const m of messages) {
        await this.persistMessage(sessionId, m)
      }
    }

    let iterations = 0
    let lastMessage: AssistantMessage = { role: 'assistant', content: '', toolCalls: [] }

    try {
      while (true) {
        if (signal?.aborted) {
          throw new AbortError('signal aborted')
        }
        iterations += 1
        if (iterations > maxIterations) {
          throw new MaxIterationsExceededError(maxIterations)
        }

        await this.hooks.dispatch(
          { kind: 'step:start', iteration: iterations },
          { sessionId, iteration: iterations, startedAt: Date.now() },
        )

        // Call the provider.
        const response = await this.callProvider(messages, budget, signal)

        // Track usage.
        if (response.message.usage) {
          budget.addTokens(response.message.usage.totalTokens)
        }

        // Append assistant message to history and persist.
        messages.push(response.message)
        lastMessage = response.message
        await this.hooks.dispatch(
          { kind: 'message:append', message: response.message },
          { sessionId, iteration: iterations, startedAt: Date.now() },
        )
        if (this.memory) {
          await this.persistMessage(sessionId, response.message)
        }

        await this.hooks.dispatch(
          { kind: 'step:end', iteration: iterations, message: response.message },
          { sessionId, iteration: iterations, startedAt: Date.now() },
        )

        // If the model didn't ask for tools, we're done.
        if (response.message.toolCalls.length === 0) {
          break
        }

        // Grace-call check: if budget is exhausted AND this isn't the grace
        // round, throw. We allow one extra round to let the model wrap up.
        if (budget.isExceeded() && !(oneTurnGrace && iterations === maxIterations)) {
          budget.check()
        }

        // Dispatch each tool call, then append a single tool message with
        // all results.
        const results: ToolResult[] = []
        for (const call of response.message.toolCalls) {
          await this.hooks.dispatch(
            { kind: 'tool:call', toolCall: call },
            { sessionId, iteration: iterations, startedAt: Date.now() },
          )
          const startedAt = Date.now()
          const result = await this.dispatchToolCall(call, signal)
          const durationMs = Date.now() - startedAt
          await this.hooks.dispatch(
            { kind: 'tool:result', toolCall: call, result, durationMs },
            { sessionId, iteration: iterations, startedAt: Date.now() },
          )
          results.push(result)
        }

        const toolMessage: Message = { role: 'tool', results }
        messages.push(toolMessage)
        if (this.memory) {
          await this.persistMessage(sessionId, toolMessage)
        }
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

      return { sessionId, finalMessage: lastMessage, iterations, messages }
    } catch (err) {
      const recoverable = err instanceof AbortError
      await this.hooks.dispatch(
        {
          kind: 'error',
          error: err instanceof Error ? err : new Error(String(err)),
          recoverable,
        },
        { sessionId, iteration: iterations, startedAt: Date.now() },
      )
      throw err
    }
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
  public async *streamRun(options: AgentRunOptions): AsyncGenerator<RunEvent, AgentRunResult, void> {
    const sessionId = options.sessionId ?? newSessionId()
    const signal = options.signal
    const maxIterations = options.maxIterations ?? 50
    const oneTurnGrace = options.oneTurnGraceCall ?? true

    if (signal?.aborted) {
      throw new AbortError('pre-aborted')
    }

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: options.userMessage },
    ]
    const budget = new Budget({ tokens: this.provider.capabilities.maxContextTokens })

    yield { type: 'run:start', sessionId, userMessage: options.userMessage }

    if (this.memory) {
      await this.memory.createSession({ id: sessionId, title: options.userMessage.slice(0, 80) })
      for (const m of messages) {
        await this.persistMessage(sessionId, m)
      }
    }

    let iterations = 0
    let lastMessage: AssistantMessage = { role: 'assistant', content: '', toolCalls: [] }

    try {
      while (true) {
        if (signal?.aborted) {
          throw new AbortError('signal aborted')
        }
        iterations += 1
        if (iterations > maxIterations) {
          throw new MaxIterationsExceededError(maxIterations)
        }

        yield { type: 'text:start', iteration: iterations }

        // Stream the provider response, accumulating into a partial
        // AssistantMessage. We don't commit to history until we have
        // the whole message (so a mid-stream abort doesn't leave
        // half-written content in the conversation).
        let partial: AssistantMessage = { role: 'assistant', content: '', toolCalls: [] }
        const toolAcc = new Map<number, ToolCall>()
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
                // Some providers send deltas. We accumulate by id (or
                // by index 0 if no id).
                const key = ev.id ?? '__default__'
                const existing = toolAcc.get(0) ?? { id: '', name: '', arguments: {} as Record<string, unknown> }
                const merged: ToolCall = {
                  id: ev.id ?? existing.id,
                  name: ev.name ?? existing.name,
                  arguments: mergeArgs(existing.arguments, ev.argumentsDelta),
                }
                toolAcc.set(0, merged)
                break
              }
              case 'tool_call_complete': {
                toolAcc.set(toolAcc.size, ev.toolCall)
                break
              }
              case 'message_complete':
                if (ev.message.content !== undefined) lastContentAccumulated = ev.message.content
                if (ev.message.model !== undefined) modelFromStream = ev.message.model
                if (ev.message.finishReason !== undefined) finishFromStream = ev.message.finishReason
                if (ev.message.usage !== undefined) usageFromStream = ev.message.usage
                // Some providers (and our scripted tests) only reveal
                // tool calls in the final `message_complete` event.
                // Merge them in so the assembled message reflects them.
                if (ev.message.toolCalls.length > 0) {
                  ev.message.toolCalls.forEach((tc, i) => toolAcc.set(i, tc))
                }
                break
              case 'reasoning_delta':
                // Surfaced as part of `partial.reasoning`; for now we
                // don't emit a UI event for it but the field is
                // available for future use.
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

        // Build the final assistant message for this step.
        const toolCalls: ToolCall[] =
          toolAcc.size > 0 ? [...toolAcc.values()] : partial.toolCalls
        const assembled: AssistantMessage = {
          role: 'assistant',
          content: lastContentAccumulated.length > 0 ? lastContentAccumulated : partial.content,
          toolCalls,
          ...(modelFromStream !== undefined ? { model: modelFromStream } : {}),
          ...(finishFromStream !== undefined ? { finishReason: finishFromStream } : {}),
          ...(usageFromStream !== undefined ? { usage: usageFromStream } : {}),
          ...(partial.reasoning !== undefined ? { reasoning: partial.reasoning } : {}),
        }
        // Some providers stream a finished AssistantMessage in
        // `message_complete` — prefer those fields if present.
        if (assembled.toolCalls.length === 0 && partial.toolCalls.length > 0) {
          assembled.toolCalls = partial.toolCalls
        }

        if (assembled.usage) budget.addTokens(assembled.usage.totalTokens)

        yield { type: 'text:end', content: assembled.content ?? '', iteration: iterations }

        messages.push(assembled)
        lastMessage = assembled
        if (this.memory) await this.persistMessage(sessionId, assembled)

        if (assembled.toolCalls.length === 0) {
          // Final step with no tool calls — surface the message and
          // exit the loop. The `step:end` here is the last one of the
          // run.
          yield { type: 'step:end', iteration: iterations, message: assembled }
          break
        }

        if (budget.isExceeded() && !(oneTurnGrace && iterations === maxIterations)) {
          budget.check()
        }

        // Dispatch each tool call. Tools run sequentially for now
        // (parallel tool calls would need separate budget tracking).
        const toolResults: ToolResult[] = []
        for (const call of assembled.toolCalls) {
          yield { type: 'tool:start', toolCall: call, iteration: iterations }
          const startedAt = Date.now()
          const result = await this.dispatchToolCall(call, signal)
          const durationMs = Date.now() - startedAt
          yield { type: 'tool:end', toolCall: call, result, durationMs, iteration: iterations }
          toolResults.push(result)
        }
        const toolMessage: Message = { role: 'tool', results: toolResults }
        messages.push(toolMessage)
        if (this.memory) await this.persistMessage(sessionId, toolMessage)

        // step:end comes after tool dispatch so the UI can show the
        // full "thought → action → result" cycle in one screen frame.
        yield { type: 'step:end', iteration: iterations, message: assembled }
      }

      const finalResult: AgentRunResult = { sessionId, finalMessage: lastMessage, iterations, messages }
      yield { type: 'run:end', finalMessage: lastMessage, iterations }
      return finalResult
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      yield { type: 'error', error }
      throw err
    }
  }

  /**
   * Convenience: stream the response. Wraps `run()` and yields the
   * provider's stream events as they arrive, but only for the *last*
   * assistant turn (intermediate turns are awaited in full because their
   * tool calls need to be dispatched).
   */
  public async *stream(
    options: AgentRunOptions,
  ): AsyncGenerator<StreamEvent | { type: 'tool_complete'; toolCall: ToolCall; result: ToolResult }, void, void> {
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

  private async dispatchToolCall(call: ToolCall, signal: AbortSignal | undefined): Promise<ToolResult> {
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
        sessionId: '',
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
        data: typeof output === 'object' && output !== null ? (output as Record<string, unknown>) : undefined,
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
      content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    } else if (role === 'assistant') {
      content = message.content ?? ''
      toolName = message.toolCalls.length > 0 ? message.toolCalls.map((t: ToolCall) => t.name).join(',') : undefined
    } else if (role === 'tool') {
      content = message.results.map((r: ToolResult) => r.content ?? '').join('\n')
      toolName = message.results[0]?.toolCallId
    }
    await this.memory.appendMessage({ sessionId, role, content, toolName })
  }
}
