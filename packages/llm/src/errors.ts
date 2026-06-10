/**
 * LLM-specific error types and shared parsing helpers.
 *
 * The provider contract in `@lumen/core` already exports a generic
 * {@link ProviderError} that wraps any LLM backend failure with `providerId`,
 * `statusCode`, and `retryable` metadata. This file adds the few sub-types
 * and helpers that are useful when implementing a concrete provider.
 */

import type { z } from 'zod'

/** Thrown when an OpenAI-compatible provider returns a non-2xx HTTP response. */
export class HttpStatusError extends Error {
  public readonly status: number
  public readonly body: string
  public readonly retryable: boolean

  constructor(status: number, body: string, retryable: boolean) {
    super(`OpenAI-compatible provider returned HTTP ${status}: ${truncate(body, 200)}`)
    this.name = 'HttpStatusError'
    this.status = status
    this.body = body
    this.retryable = retryable
  }
}

/**
 * Thrown when an OpenAI-compatible provider's response body fails Zod
 * validation. The captured body is kept verbatim for debugging — providers
 * have a habit of changing shapes in minor releases.
 */
export class ResponseShapeError extends Error {
  public readonly issues: ReadonlyArray<{ path: string; message: string }>
  public readonly rawBody: string

  constructor(issues: ReadonlyArray<{ path: string; message: string }>, rawBody: string) {
    super(
      `OpenAI-compatible provider returned a response that failed schema validation: ${issues
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ')}`,
    )
    this.name = 'ResponseShapeError'
    this.issues = issues
    this.rawBody = rawBody
  }
}

/** Thrown when SSE chunks cannot be parsed or contain a non-data payload. */
export class StreamParseError extends Error {
  public readonly line: string

  constructor(line: string, cause?: unknown) {
    super(`Failed to parse SSE chunk: ${truncate(line, 200)}`, { cause })
    this.name = 'StreamParseError'
    this.line = line
  }
}

/**
 * Classify an HTTP status as retryable.
 *
 * 5xx and 429 are universally considered safe to retry. 408 (request timeout)
 * is a borderline case we treat as retryable. 4xx other than 408/429 are
 * caller errors and not retryable.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true
  return status >= 500 && status < 600
}

/**
 * Parse a JSON string into a Zod-validated shape, throwing a typed error
 * on either failure. Lives in `errors.ts` (not in any provider module)
 * because every LLM provider does exactly this dance and we don't want
 * each one to reinvent the catch / rethrow logic.
 */
export function parseResponseJson<S extends z.ZodTypeAny>(text: string, schema: S): z.infer<S> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (_cause) {
    throw new ResponseShapeError([{ path: '<root>', message: 'response is not valid JSON' }], text)
  }
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.') || '<root>',
      message: i.message,
    }))
    throw new ResponseShapeError(issues, text)
  }
  return result.data
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}
