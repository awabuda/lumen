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
import type { LumenConfig } from '@lumen/config';
import type { AssistantMessage, Message, StreamEvent, ToolCall, ToolResult } from '../message/index.js';
import { BaseProvider } from '../message/provider.js';
import { ToolRegistry } from '../tools/index.js';
import { BaseMemoryStore } from '../memory/index.js';
import { HookRegistry } from '../hooks/index.js';
export interface AgentConfig {
    /** The LLM provider to call. Required. */
    readonly provider: BaseProvider;
    /** Tools the agent may invoke. Required. */
    readonly tools: ToolRegistry;
    /** Memory store. Optional — if omitted, runs are ephemeral. */
    readonly memory?: BaseMemoryStore;
    /** Hook registry. Optional — defaults to empty. */
    readonly hooks?: HookRegistry;
    /** Loaded Lumen config. Optional — sensible defaults are used if omitted. */
    readonly config?: LumenConfig;
    /** Model identifier to pass to the provider. Defaults to `config.defaultModel`. */
    readonly model?: string;
    /** System prompt. Defaults to a minimal neutral prompt. */
    readonly systemPrompt?: string;
    /** Working directory (passed to tools via ToolContext). */
    readonly cwd?: string;
}
export interface AgentRunOptions {
    /** Initial user message. */
    readonly userMessage: string;
    /** Optional session id; a new one is generated if omitted. */
    readonly sessionId?: string;
    /** Abort signal for cancellation. */
    readonly signal?: AbortSignal;
    /**
     * Maximum number of agent iterations (model->tool->model cycles).
     * Overrides the config default.
     */
    readonly maxIterations?: number;
    /**
     * If true, allow one extra iteration after the budget is exceeded,
     * giving the model a chance to emit a final answer rather than being
     * cut off mid-thought.
     */
    readonly oneTurnGraceCall?: boolean;
}
export interface AgentRunResult {
    readonly sessionId: string;
    readonly finalMessage: AssistantMessage;
    readonly iterations: number;
    readonly messages: ReadonlyArray<Message>;
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
export type RunEvent = {
    type: 'run:start';
    sessionId: string;
    userMessage: string;
} | {
    type: 'text:start';
    iteration: number;
} | {
    type: 'text:delta';
    delta: string;
} | {
    type: 'text:end';
    content: string;
    iteration: number;
} | {
    type: 'tool:start';
    toolCall: ToolCall;
    iteration: number;
} | {
    type: 'tool:end';
    toolCall: ToolCall;
    result: ToolResult;
    durationMs: number;
    iteration: number;
} | {
    type: 'step:end';
    iteration: number;
    message: AssistantMessage;
} | {
    type: 'run:end';
    finalMessage: AssistantMessage;
    iterations: number;
} | {
    type: 'error';
    error: Error;
};
export declare class Agent {
    private readonly provider;
    private readonly tools;
    private readonly memory?;
    private readonly hooks;
    private readonly model;
    private readonly systemPrompt;
    private readonly cwd;
    constructor(config: AgentConfig);
    /**
     * Run the agent loop to completion on a single user message.
     * Returns the final assistant message plus the full message history.
     */
    run(options: AgentRunOptions): Promise<AgentRunResult>;
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
    streamRun(options: AgentRunOptions): AsyncGenerator<RunEvent, AgentRunResult, void>;
    /**
     * Convenience: stream the response. Wraps `run()` and yields the
     * provider's stream events as they arrive, but only for the *last*
     * assistant turn (intermediate turns are awaited in full because their
     * tool calls need to be dispatched).
     */
    stream(options: AgentRunOptions): AsyncGenerator<StreamEvent | {
        type: 'tool_complete';
        toolCall: ToolCall;
        result: ToolResult;
    }, void, void>;
    private callProvider;
    private dispatchToolCall;
    private persistMessage;
}
//# sourceMappingURL=index.d.ts.map