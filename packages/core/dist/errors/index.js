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
export class AgentError extends Error {
    cause;
    constructor(message, options) {
        super(message, options);
        this.name = 'AgentError';
        this.cause = options?.cause;
    }
}
/** Provider (LLM) call failed. */
export class ProviderError extends AgentError {
    providerId;
    statusCode;
    retryable;
    constructor(message, init) {
        super(message, { cause: init.cause });
        this.name = 'ProviderError';
        this.providerId = init.providerId;
        this.statusCode = init.statusCode;
        this.retryable = init.retryable ?? false;
    }
}
/** Tool execution failed at runtime (network, filesystem, etc). */
export class ToolError extends AgentError {
    toolName;
    constructor(message, init) {
        super(message, { cause: init.cause });
        this.name = 'ToolError';
        this.toolName = init.toolName;
    }
}
/** Tool input did not validate against its Zod schema. */
export class ToolValidationError extends ToolError {
    issues;
    constructor(toolName, issues, cause) {
        super(`Tool ${toolName} input validation failed`, { toolName, cause });
        this.name = 'ToolValidationError';
        this.issues = issues;
    }
}
/** Agent loop hit max iterations without a final response. */
export class MaxIterationsExceededError extends AgentError {
    iterations;
    constructor(iterations) {
        super(`Agent exceeded maximum iterations (${iterations})`);
        this.name = 'MaxIterationsExceededError';
        this.iterations = iterations;
    }
}
/** Budget (tokens / cost / time) was exhausted. */
export class BudgetExceededError extends AgentError {
    kind;
    constructor(kind, limit, used) {
        super(`Budget exhausted: ${kind} used ${used} of ${limit}`);
        this.name = 'BudgetExceededError';
        this.kind = kind;
    }
}
/** Caller aborted the run (e.g. Ctrl+C, timeout, explicit cancel). */
export class AbortError extends AgentError {
    constructor(reason = 'aborted') {
        super(`Agent run aborted: ${reason}`);
        this.name = 'AbortError';
    }
}
//# sourceMappingURL=index.js.map