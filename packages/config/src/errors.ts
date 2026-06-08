/**
 * Configuration error types.
 *
 * Config errors are user-facing; the loader should wrap Zod errors in these
 * types so the CLI can render a friendly message.
 */

export class ConfigError extends Error {
  public override readonly cause?: unknown

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigError'
    this.cause = options?.cause
  }
}

export class ConfigValidationError extends ConfigError {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>

  constructor(
    message: string,
    issues: ReadonlyArray<{ path: string; message: string }>,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ConfigValidationError'
    this.issues = issues
  }
}

export class ConfigSourceNotFoundError extends ConfigError {
  constructor(path: string) {
    super(`Configuration source not found: ${path}`)
    this.name = 'ConfigSourceNotFoundError'
  }
}
