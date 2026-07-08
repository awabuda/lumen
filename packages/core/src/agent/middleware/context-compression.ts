/**
 * Context compression middleware (P20.3) — collapse long
 * message histories into a rolling summary.
 *
 * Borrowed shape from deepagents' default stack: when the
 * conversation grows past `maxMessages`, replace the oldest
 * half with a single system message carrying a summary
 * (default: a deterministic first-N-words truncation, callers
 * can pass an LLM-backed `summaryFn` for higher quality).
 *
 * Why a middleware and not an AgentConfig boolean:
 *   - The compression strategy is **policy**: which messages
 *     to keep, how to summarise them, when to fire. P19+ rule
 *     11 says policy on the agent loop = middleware.
 *   - Lumen has no `AgentConfig.compress: true` flag; callers
 *     wire the middleware via `createAgent({ middleware: [...] })`.
 *
 * Why BeforeModel (not wrapModelCall):
 *   - The hook returns the new `messages` array directly. No
 *     need to wrap the call; we just transform the input and
 *     let the agent loop call the provider with the truncated
 *     history.
 *   - Reflection uses `afterModel` to append metadata; context
 *     compression is a **before**-the-call operation, so
 *     `beforeModel` is the natural fit.
 *
 * Determinism:
 *   - The default `summaryFn` is a pure function over the
 *     messages it is given; it does NOT call an LLM. Callers
 *     who want LLM-backed summarisation pass an explicit
 *     `summaryFn: (msgs) => Promise<string>` that hits their
 *     provider. The middleware itself stays deterministic
 *     and CI-friendly.
 */

import { z } from 'zod'

import type { AgentMiddleware } from '../middleware.js'
import type { Message } from '../../message/index.js'

/** Configurable rule set. All fields are optional. */
export const ContextCompressionOptionsSchema = z
  .object({
    /** Total message count above which compression fires. */
    maxMessages: z.number().int().positive().optional(),
    /** Number of trailing messages to keep verbatim. */
    keepLastN: z.number().int().positive().optional(),
    /**
     * Optional summariser. Receives the messages that are
     * about to be discarded, returns a string. If omitted, a
     * deterministic truncation is used (first 200 chars of
     * the first discarded message, then "[...]").
     */
    summaryFn: z.custom<(msgs: ReadonlyArray<Message>) => string | Promise<string>>().optional(),
  })
  .strict()

export type ContextCompressionOptions = z.infer<typeof ContextCompressionOptionsSchema>

const DEFAULT_MAX_MESSAGES = 20
const DEFAULT_KEEP_LAST_N = 10
const DEFAULT_SUMMARY_HEAD_CHARS = 200

/**
 * Default deterministic summariser: a short header describing
 * the discarded message count, plus the first N characters of
 * the first discarded message. Pure function, no LLM.
 */
const defaultSummarise = (msgs: ReadonlyArray<Message>): string => {
  if (msgs.length === 0) return '(no prior messages)'
  const first = msgs[0]
  if (!first) return '(no prior messages)'
  const head = ('content' in first ? String(first.content) : '').slice(0, DEFAULT_SUMMARY_HEAD_CHARS)
  return `[Earlier conversation summary] ${msgs.length} message(s) collapsed. First message: ${head}`
}

/**
 * Create a context-compression middleware.
 *
 * Algorithm:
 *   1. If `messages.length <= maxMessages`, return the array unchanged.
 *   2. Otherwise split: `toKeep = messages.slice(-keepLastN)` and
 *      `toCompress = messages.slice(0, -keepLastN)`.
 *   3. Run `summaryFn(toCompress)` (or the default) to produce
 *      a single summary string.
 *   4. Build a system-role message carrying the summary, prepend
 *      it to `toKeep`, and return that as the new messages array.
 */
export const createContextCompressionMiddleware = (
  options: ContextCompressionOptions = {},
): AgentMiddleware<Record<string, never>> => {
  const parsed = ContextCompressionOptionsSchema.parse(options)
  const maxMessages = parsed.maxMessages ?? DEFAULT_MAX_MESSAGES
  const keepLastN = parsed.keepLastN ?? DEFAULT_KEEP_LAST_N
  if (keepLastN >= maxMessages) {
    throw new Error(
      `createContextCompressionMiddleware: keepLastN (${keepLastN}) must be less than maxMessages (${maxMessages})`,
    )
  }
  const summarise = parsed.summaryFn ?? defaultSummarise

  return {
    name: 'context-compression',
    stateSchema: z.object({}).strict(),
    initialState: {},
    beforeModel: async (messages) => {
      if (messages.length <= maxMessages) {
        return messages
      }
      const toCompress = messages.slice(0, -keepLastN)
      const toKeep = messages.slice(-keepLastN)
      const summary = await summarise(toCompress)
      const summaryMessage: Message = {
        role: 'system',
        content: summary,
      }
      return [summaryMessage, ...toKeep]
    },
  }
}
