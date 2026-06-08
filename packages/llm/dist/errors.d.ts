/**
 * LLM-specific error types.
 *
 * The provider contract in `@lumen/core` already exports a generic
 * {@link ProviderError} that wraps any LLM backend failure with `providerId`,
 * `statusCode`, and `retryable` metadata. This file adds the few sub-types
 * and helpers that are useful when implementing a concrete provider.
 */
/** Thrown when an OpenAI-compatible provider returns a non-2xx HTTP response. */
export declare class HttpStatusError extends Error {
    readonly status: number;
    readonly body: string;
    readonly retryable: boolean;
    constructor(status: number, body: string, retryable: boolean);
}
/**
 * Thrown when an OpenAI-compatible provider's response body fails Zod
 * validation. The captured body is kept verbatim for debugging — providers
 * have a habit of changing shapes in minor releases.
 */
export declare class ResponseShapeError extends Error {
    readonly issues: ReadonlyArray<{
        path: string;
        message: string;
    }>;
    readonly rawBody: string;
    constructor(issues: ReadonlyArray<{
        path: string;
        message: string;
    }>, rawBody: string);
}
/** Thrown when SSE chunks cannot be parsed or contain a non-data payload. */
export declare class StreamParseError extends Error {
    readonly line: string;
    constructor(line: string, cause?: unknown);
}
/**
 * Classify an HTTP status as retryable.
 *
 * 5xx and 429 are universally considered safe to retry. 408 (request timeout)
 * is a borderline case we treat as retryable. 4xx other than 408/429 are
 * caller errors and not retryable.
 */
export declare function isRetryableStatus(status: number): boolean;
//# sourceMappingURL=errors.d.ts.map