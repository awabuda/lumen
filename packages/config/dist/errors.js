/**
 * Configuration error types.
 *
 * Config errors are user-facing; the loader should wrap Zod errors in these
 * types so the CLI can render a friendly message.
 */
export class ConfigError extends Error {
    cause;
    constructor(message, options) {
        super(message, options);
        this.name = 'ConfigError';
        this.cause = options?.cause;
    }
}
export class ConfigValidationError extends ConfigError {
    issues;
    constructor(message, issues, options) {
        super(message, options);
        this.name = 'ConfigValidationError';
        this.issues = issues;
    }
}
export class ConfigSourceNotFoundError extends ConfigError {
    constructor(path) {
        super(`Configuration source not found: ${path}`);
        this.name = 'ConfigSourceNotFoundError';
    }
}
//# sourceMappingURL=errors.js.map