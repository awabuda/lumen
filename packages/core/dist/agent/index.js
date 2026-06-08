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
import { HookRegistry } from '../hooks/index.js';
import { Budget } from '../budget/index.js';
import { AbortError, MaxIterationsExceededError, ProviderError, ToolError } from '../errors/index.js';
/** Default neutral system prompt. Override via {@link AgentConfig.systemPrompt}. */
const DEFAULT_SYSTEM_PROMPT = `You are Lumen, a self-improving AI agent.
You may use tools to gather information and take actions.
Prefer minimal, surgical actions. Explain your reasoning before tool calls.
When you have a final answer, state it directly.`;
/** Cryptographically-random ID for sessions (uses Web Crypto, available in Node 20+). */
const newSessionId = () => {
    // Node 20 has globalThis.crypto.randomUUID
    return globalThis.crypto.randomUUID();
};
export class Agent {
    provider;
    tools;
    memory;
    hooks;
    model;
    systemPrompt;
    cwd;
    constructor(config) {
        this.provider = config.provider;
        this.tools = config.tools;
        this.memory = config.memory;
        this.hooks = config.hooks ?? new HookRegistry();
        this.model = config.model ?? config.config?.defaultModel ?? 'gpt-4o-mini';
        this.systemPrompt = config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
        this.cwd = config.cwd ?? process.cwd();
    }
    /**
     * Run the agent loop to completion on a single user message.
     * Returns the final assistant message plus the full message history.
     */
    async run(options) {
        const sessionId = options.sessionId ?? newSessionId();
        const signal = options.signal;
        const maxIterations = options.maxIterations ?? 50;
        const oneTurnGrace = options.oneTurnGraceCall ?? true;
        // Wire signal -> our abort tracking. The agent checks signal.aborted
        // at every loop boundary.
        if (signal?.aborted) {
            throw new AbortError('pre-aborted');
        }
        const messages = [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: options.userMessage },
        ];
        const budget = new Budget({
            tokens: this.provider.capabilities.maxContextTokens, // rough upper bound
        });
        await this.hooks.dispatch({ kind: 'run:start', sessionId, userMessage: options.userMessage }, { sessionId, iteration: 0, startedAt: Date.now() });
        // Persist initial messages if memory is available.
        if (this.memory) {
            await this.memory.createSession({ id: sessionId, title: options.userMessage.slice(0, 80) });
            for (const m of messages) {
                await this.persistMessage(sessionId, m);
            }
        }
        let iterations = 0;
        let lastMessage = { role: 'assistant', content: '', toolCalls: [] };
        try {
            while (true) {
                if (signal?.aborted) {
                    throw new AbortError('signal aborted');
                }
                iterations += 1;
                if (iterations > maxIterations) {
                    throw new MaxIterationsExceededError(maxIterations);
                }
                await this.hooks.dispatch({ kind: 'step:start', iteration: iterations }, { sessionId, iteration: iterations, startedAt: Date.now() });
                // Call the provider.
                const response = await this.callProvider(messages, budget, signal);
                // Track usage.
                if (response.message.usage) {
                    budget.addTokens(response.message.usage.totalTokens);
                }
                // Append assistant message to history and persist.
                messages.push(response.message);
                lastMessage = response.message;
                await this.hooks.dispatch({ kind: 'message:append', message: response.message }, { sessionId, iteration: iterations, startedAt: Date.now() });
                if (this.memory) {
                    await this.persistMessage(sessionId, response.message);
                }
                await this.hooks.dispatch({ kind: 'step:end', iteration: iterations, message: response.message }, { sessionId, iteration: iterations, startedAt: Date.now() });
                // If the model didn't ask for tools, we're done.
                if (response.message.toolCalls.length === 0) {
                    break;
                }
                // Grace-call check: if budget is exhausted AND this isn't the grace
                // round, throw. We allow one extra round to let the model wrap up.
                if (budget.isExceeded() && !(oneTurnGrace && iterations === maxIterations)) {
                    budget.check();
                }
                // Dispatch each tool call, then append a single tool message with
                // all results.
                const results = [];
                for (const call of response.message.toolCalls) {
                    await this.hooks.dispatch({ kind: 'tool:call', toolCall: call }, { sessionId, iteration: iterations, startedAt: Date.now() });
                    const startedAt = Date.now();
                    const result = await this.dispatchToolCall(call, signal);
                    const durationMs = Date.now() - startedAt;
                    await this.hooks.dispatch({ kind: 'tool:result', toolCall: call, result, durationMs }, { sessionId, iteration: iterations, startedAt: Date.now() });
                    results.push(result);
                }
                const toolMessage = { role: 'tool', results };
                messages.push(toolMessage);
                if (this.memory) {
                    await this.persistMessage(sessionId, toolMessage);
                }
            }
            await this.hooks.dispatch({
                kind: 'run:end',
                sessionId,
                finalMessage: lastMessage,
                iterations,
            }, { sessionId, iteration: iterations, startedAt: Date.now() });
            return { sessionId, finalMessage: lastMessage, iterations, messages };
        }
        catch (err) {
            const recoverable = err instanceof AbortError;
            await this.hooks.dispatch({
                kind: 'error',
                error: err instanceof Error ? err : new Error(String(err)),
                recoverable,
            }, { sessionId, iteration: iterations, startedAt: Date.now() });
            throw err;
        }
    }
    /**
     * Convenience: stream the response. Wraps `run()` and yields the
     * provider's stream events as they arrive, but only for the *last*
     * assistant turn (intermediate turns are awaited in full because their
     * tool calls need to be dispatched).
     */
    async *stream(options) {
        // For now, we keep streaming simple: run synchronously, then yield
        // events from the final provider call only. A more sophisticated
        // implementation would interleave streaming with tool dispatch.
        const promise = this.run(options);
        // We can't actually stream mid-run with this approach; we yield a
        // marker and then the result. The CLI can use a different strategy
        // (see `run` directly with its own iteration loop) when true
        // token-by-token streaming is needed.
        yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } };
        const result = await promise;
        if (result.finalMessage.content) {
            yield { type: 'content_delta', delta: result.finalMessage.content };
        }
        for (const tc of result.finalMessage.toolCalls) {
            yield { type: 'tool_call_complete', toolCall: tc };
        }
        yield { type: 'message_complete', message: result.finalMessage };
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    async callProvider(messages, _budget, signal) {
        try {
            return await this.provider.chat({ messages, model: this.model }, signal ? { signal } : undefined);
        }
        catch (err) {
            if (err instanceof ProviderError)
                throw err;
            throw new ProviderError(`Provider ${this.provider.id} failed: ${err.message ?? String(err)}`, {
                providerId: this.provider.id,
                cause: err,
                retryable: false,
            });
        }
    }
    async dispatchToolCall(call, signal) {
        const tool = this.tools.get(call.name);
        if (!tool) {
            return {
                toolCallId: call.id,
                isError: true,
                content: `Tool "${call.name}" is not registered`,
            };
        }
        try {
            const output = await tool.call(call.arguments, {
                cwd: this.cwd,
                signal: signal ?? new AbortController().signal,
                sessionId: '',
                log: undefined,
            });
            return {
                toolCallId: call.id,
                isError: false,
                content: typeof output === 'string' ? output : JSON.stringify(output),
                data: typeof output === 'object' && output !== null ? output : undefined,
            };
        }
        catch (err) {
            if (err instanceof ToolError) {
                return {
                    toolCallId: call.id,
                    isError: true,
                    content: err.message,
                };
            }
            return {
                toolCallId: call.id,
                isError: true,
                content: `Tool execution failed: ${err.message ?? String(err)}`,
            };
        }
    }
    async persistMessage(sessionId, message) {
        if (!this.memory)
            return;
        const role = message.role;
        let content = '';
        let toolName;
        if (role === 'user' || role === 'system') {
            content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        }
        else if (role === 'assistant') {
            content = message.content ?? '';
            toolName = message.toolCalls.length > 0 ? message.toolCalls.map((t) => t.name).join(',') : undefined;
        }
        else if (role === 'tool') {
            content = message.results.map((r) => r.content ?? '').join('\n');
            toolName = message.results[0]?.toolCallId;
        }
        await this.memory.appendMessage({ sessionId, role, content, toolName });
    }
}
//# sourceMappingURL=index.js.map