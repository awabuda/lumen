/**
 * Error types for the Lumen agent runtime.
 *
 * Every public failure is an `AgentError` so callers can `instanceof` check
 * the base type. Specific subclasses carry richer context.
 *
 * Conventions:
 *   - `public override readonly` for fields that shadow Error.cause
 *   - `options?: { cause?: unknown }` for the Error super-call
 *   - `name` is always set explicitly (default is "Error", which is useless
 *     in logs and stack traces)
 */
/** Root of the error hierarchy. Catch this for "any agent failure". */
export declare class AgentError extends Error {
    readonly cause?: unknown;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Provider (LLM) call failed. */
export declare class ProviderError extends AgentError {
    readonly providerId: string;
    readonly statusCode?: number;
    readonly retryable: boolean;
    constructor(message: string, init: {
        providerId: string;
        statusCode?: number;
        retryable?: boolean;
        cause?: unknown;
    });
}
/** Tool execution failed at runtime (network, filesystem, etc). */
export declare class ToolError extends AgentError {
    readonly toolName: string;
    constructor(message: string, init: {
        toolName: string;
        cause?: unknown;
    });
}
/** Tool input did not validate against its Zod schema. */
export declare class ToolValidationError extends ToolError {
    readonly issues: ReadonlyArray<{
        path: string;
        message: string;
    }>;
    constructor(toolName: string, issues: ReadonlyArray<{
        path: string;
        message: string;
    }>, cause?: unknown);
}
/** Agent loop hit max iterations without a final response. */
export declare class MaxIterationsExceededError extends AgentError {
    readonly iterations: number;
    constructor(iterations: number);
}
/** Budget (tokens / cost / time) was exhausted. */
export declare class BudgetExceededError extends AgentError {
    readonly kind: 'tokens' | 'cost' | 'time';
    constructor(kind: 'tokens' | 'cost' | 'time', limit: number, used: number);
}
/** Caller aborted the run (e.g. Ctrl+C, timeout, explicit cancel). */
export declare class AbortError extends AgentError {
    constructor(reason?: string);
}
//# sourceMappingURL=index.d.ts.map