/**
 * Configuration error types.
 *
 * Config errors are user-facing; the loader should wrap Zod errors in these
 * types so the CLI can render a friendly message.
 */
export declare class ConfigError extends Error {
    readonly cause?: unknown;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare class ConfigValidationError extends ConfigError {
    readonly issues: ReadonlyArray<{
        path: string;
        message: string;
    }>;
    constructor(message: string, issues: ReadonlyArray<{
        path: string;
        message: string;
    }>, options?: {
        cause?: unknown;
    });
}
export declare class ConfigSourceNotFoundError extends ConfigError {
    constructor(path: string);
}
//# sourceMappingURL=errors.d.ts.map