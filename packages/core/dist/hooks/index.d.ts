/**
 * Hook system — observer pattern for the agent lifecycle.
 *
 * Hooks are NOT a base contract you subclass. They're a function-based
 * subscription: register a callback, get notified on lifecycle events.
 *
 * Why function-based instead of class-based:
 *   - Hooks are usually 5-10 lines, often closures.
 *   - Class-based forces a name; function-based lets you compose.
 *   - Easier to add/remove dynamically.
 *
 * Hooks run sequentially in registration order. Errors in a hook are
 * caught and logged but do NOT abort the run (the agent must not be
 * fragile to a misbehaving observer).
 */
import type { Message, ToolCall, ToolResult, AssistantMessage } from '../message/index.js';
/** Lifecycle events the agent emits. */
export type HookEvent = {
    kind: 'run:start';
    sessionId: string;
    userMessage: string;
} | {
    kind: 'run:end';
    sessionId: string;
    finalMessage: AssistantMessage;
    iterations: number;
} | {
    kind: 'step:start';
    iteration: number;
} | {
    kind: 'step:end';
    iteration: number;
    message: AssistantMessage;
} | {
    kind: 'message:append';
    message: Message;
} | {
    kind: 'tool:call';
    toolCall: ToolCall;
} | {
    kind: 'tool:result';
    toolCall: ToolCall;
    result: ToolResult;
    durationMs: number;
} | {
    kind: 'error';
    error: Error;
    recoverable: boolean;
};
/** Per-invocation context for hooks. */
export interface HookContext {
    readonly sessionId: string;
    readonly iteration: number;
    readonly startedAt: number;
}
/** A single hook is a function that may return a Promise. */
export type Hook = (event: HookEvent, ctx: HookContext) => void | Promise<void>;
/**
 * Registry of hooks. Hooks are called in registration order.
 * Failures in one hook do not affect others.
 */
export declare class HookRegistry {
    private readonly hooks;
    private nextId;
    /** Register a hook. Returns an unregister function. */
    register(hook: Hook): () => void;
    /** Dispatch an event to all hooks. Returns when all hooks have settled. */
    dispatch(event: HookEvent, ctx: HookContext): Promise<void>;
    /** Number of registered hooks. */
    get size(): number;
}
//# sourceMappingURL=index.d.ts.map