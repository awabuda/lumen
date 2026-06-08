/**
 * LLM-specific error types.
 *
 * The provider contract in `@lumen/core` already exports a generic
 * {@link ProviderError} that wraps any LLM backend failure with `providerId`,
 * `statusCode`, and `retryable` metadata. This file adds the few sub-types
 * and helpers that are useful when implementing a concrete provider.
 */
/** Thrown when an OpenAI-compatible provider returns a non-2xx HTTP response. */
export class HttpStatusError extends Error {
    status;
    body;
    retryable;
    constructor(status, body, retryable) {
        super(`OpenAI-compatible provider returned HTTP ${status}: ${truncate(body, 200)}`);
        this.name = 'HttpStatusError';
        this.status = status;
        this.body = body;
        this.retryable = retryable;
    }
}
/**
 * Thrown when an OpenAI-compatible provider's response body fails Zod
 * validation. The captured body is kept verbatim for debugging — providers
 * have a habit of changing shapes in minor releases.
 */
export class ResponseShapeError extends Error {
    issues;
    rawBody;
    constructor(issues, rawBody) {
        super(`OpenAI-compatible provider returned a response that failed schema validation: ${issues
            .map((i) => `${i.path}: ${i.message}`)
            .join('; ')}`);
        this.name = 'ResponseShapeError';
        this.issues = issues;
        this.rawBody = rawBody;
    }
}
/** Thrown when SSE chunks cannot be parsed or contain a non-data payload. */
export class StreamParseError extends Error {
    line;
    constructor(line, cause) {
        super(`Failed to parse SSE chunk: ${truncate(line, 200)}`, { cause });
        this.name = 'StreamParseError';
        this.line = line;
    }
}
/**
 * Classify an HTTP status as retryable.
 *
 * 5xx and 429 are universally considered safe to retry. 408 (request timeout)
 * is a borderline case we treat as retryable. 4xx other than 408/429 are
 * caller errors and not retryable.
 */
export function isRetryableStatus(status) {
    if (status === 408 || status === 429)
        return true;
    return status >= 500 && status < 600;
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return `${s.slice(0, max)}…`;
}
//# sourceMappingURL=errors.js.map