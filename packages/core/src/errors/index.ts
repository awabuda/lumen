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
  public override readonly cause?: unknown

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AgentError'
    this.cause = options?.cause
  }
}

/** Provider (LLM) call failed. */
export class ProviderError extends AgentError {
  public readonly providerId: string
  public readonly statusCode?: number
  public readonly retryable: boolean

  constructor(
    message: string,
    init: { providerId: string; statusCode?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: init.cause })
    this.name = 'ProviderError'
    this.providerId = init.providerId
    this.statusCode = init.statusCode
    this.retryable = init.retryable ?? false
  }
}

/** Tool execution failed at runtime (network, filesystem, etc). */
export class ToolError extends AgentError {
  public readonly toolName: string

  constructor(message: string, init: { toolName: string; cause?: unknown }) {
    super(message, { cause: init.cause })
    this.name = 'ToolError'
    this.toolName = init.toolName
  }
}

/** Tool input did not validate against its Zod schema. */
export class ToolValidationError extends ToolError {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>

  constructor(
    toolName: string,
    issues: ReadonlyArray<{ path: string; message: string }>,
    cause?: unknown,
  ) {
    super(`Tool ${toolName} input validation failed`, { toolName, cause })
    this.name = 'ToolValidationError'
    this.issues = issues
  }
}

/** Agent loop hit max iterations without a final response. */
export class MaxIterationsExceededError extends AgentError {
  public readonly iterations: number

  constructor(iterations: number) {
    super(`Agent exceeded maximum iterations (${iterations})`)
    this.name = 'MaxIterationsExceededError'
    this.iterations = iterations
  }
}

/** Budget (tokens / cost / time) was exhausted. */
export class BudgetExceededError extends AgentError {
  public readonly kind: 'tokens' | 'cost' | 'time'

  constructor(kind: 'tokens' | 'cost' | 'time', limit: number, used: number) {
    super(`Budget exhausted: ${kind} used ${used} of ${limit}`)
    this.name = 'BudgetExceededError'
    this.kind = kind
  }
}

/** Caller aborted the run (e.g. Ctrl+C, timeout, explicit cancel). */
export class AbortError extends AgentError {
  constructor(reason: string = 'aborted') {
    super(`Agent run aborted: ${reason}`)
    this.name = 'AbortError'
  }
}

/**
 * Configuration is invalid, missing, or inconsistent.
 *
 * Use for setup-time failures that the caller can fix by changing how
 * they wired the framework: duplicate registrations, missing required
 * options, references to unknown ids, misconfigured routing strategies.
 * NOT for runtime failures (network, FS, LLM, etc).
 */
export class ConfigError extends AgentError {
  public readonly field?: string

  constructor(message: string, init: { field?: string; cause?: unknown } = {}) {
    super(message, { cause: init.cause })
    this.name = 'ConfigError'
    this.field = init.field
  }
}

/**
 * Input did not pass a structural or value-range validation.
 *
 * Use for argument validation that the caller can satisfy by providing
 * the right shape: empty arrays, out-of-range numbers, malformed
 * strings, missing required fields. Distinct from {@link ConfigError},
 * which is about *wiring* the framework, not about a single call.
 */
export class ValidationError extends AgentError {
  public readonly field?: string
  public readonly value?: unknown

  constructor(message: string, init: { field?: string; value?: unknown; cause?: unknown } = {}) {
    super(message, { cause: init.cause })
    this.name = 'ValidationError'
    this.field = init.field
    this.value = init.value
  }
}
