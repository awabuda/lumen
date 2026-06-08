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