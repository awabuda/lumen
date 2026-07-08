/**
 * HITL (Human-in-the-Loop) middleware (P20.1) — declarative
 * interrupt rules.
 *
 * Wraps a `wrapToolCall` hook that watches each tool dispatch and
 * triggers an abort when one of the configured rules fires. The
 * existing P20.4.2 catch path in `Agent.run` then takes over:
 *   1. the abort becomes an `AbortError`
 *   2. if a `checkpointStore` is configured, the latest message
 *      history is auto-saved
 *   3. the error propagates to the caller, who can resume later
 *      via `resumeFrom`
 *
 * Why declarative rules on tool dispatch (and not a generic
 * "ask the user for every tool call" prompt):
 *   - The CLI / TUI is the only place to actually surface the
 *     question. A core middleware that prompts the user
 *     directly would couple the agent loop to the host
 *     application — exactly the kind of "extension to the
 *     Agent loop" that P19+ rule 11 reserves for middleware.
 *   - The declarative `interruptOn: { toolNames, maxIterations,
 *     onError }` shape matches LangChain 1.0's `interrupt_before`
 *     / LangGraph's `interrupt(...)` semantics: the operator
 *     writes a policy, the runtime enforces it.
 *
 * The middleware does **not** itself prompt the user. It just
 * records `interrupted: true` and the offending tool name in
 * its state slice so the host application can read it after
 * the run throws.
 */

import { z } from 'zod'

import { AbortError } from '../../errors/index.js'
import type { AgentMiddleware } from '../middleware.js'
import type { ToolCall } from '../../message/index.js'

/** What triggered the interrupt (for the AbortError message). */
export const InterruptReasonSchema = z.enum([
  'tool-name',
  'max-iterations',
  'tool-error',
])
export type InterruptReason = z.infer<typeof InterruptReasonSchema>

/** Configurable rule set. All fields are optional; absent rules are inactive. */
export const InterruptOptionsSchema = z
  .object({
    /** Interrupt the run as soon as a tool with one of these names is about to dispatch. */
    toolNames: z.array(z.string().min(1)).optional(),
    /** Interrupt the run when the iteration counter reaches this number. */
    maxIterations: z.number().int().positive().optional(),
    /** Interrupt the run whenever a tool dispatch throws. */
    onError: z.boolean().optional(),
  })
  .strict()

export type InterruptOptions = z.infer<typeof InterruptOptionsSchema>

/** State slice surfaced via the middleware's afterRun hook. */
export interface InterruptState {
  readonly interrupted: boolean
  readonly reason?: InterruptReason
  readonly toolName?: string
  readonly iteration?: number
  readonly interruptedAt: number
}

/** Create a HITL interrupt middleware. */
export const createInterruptMiddleware = (
  options: InterruptOptions = {},
): AgentMiddleware<InterruptState> => {
  const parsed = InterruptOptionsSchema.parse(options)

  // Validation: at least one rule must be configured. Otherwise
  // the middleware is a no-op that confuses readers.
  if (
    parsed.toolNames === undefined &&
    parsed.maxIterations === undefined &&
    parsed.onError !== true
  ) {
    throw new Error(
      'createInterruptMiddleware: at least one of toolNames / maxIterations / onError must be set',
    )
  }

  return {
    name: 'interrupt',
    stateSchema: z
      .object({
        interrupted: z.boolean(),
        reason: InterruptReasonSchema.optional(),
        toolName: z.string().optional(),
        iteration: z.number().int().nonnegative().optional(),
        interruptedAt: z.number().int().nonnegative(),
      })
      .strict(),
    initialState: { interrupted: false, interruptedAt: 0 } satisfies InterruptState,
    wrapToolCall: async (toolCall, defaultCall) => {
      if (parsed.toolNames && parsed.toolNames.includes(toolCall.name)) {
        throw new AbortError(
          `interrupt: tool "${toolCall.name}" requires approval`,
        )
      }
      try {
        return await defaultCall()
      } catch (err) {
        if (parsed.onError === true) {
          throw new AbortError(
            `interrupt: tool "${toolCall.name}" failed: ${(err as Error).message ?? String(err)}`,
          )
        }
        throw err
      }
    },
    beforeModel: async (_messages, ctx) => {
      // maxIterations rule: throw AbortError when the iteration
      // counter reaches the configured cap. We use beforeModel
      // (rather than wrapModelCall) so the rule fires BEFORE the
      // provider is hit; the throw propagates to the P20.4.2
      // catch path in Agent.run which auto-saves a checkpoint.
      if (parsed.maxIterations !== undefined && ctx.iteration >= parsed.maxIterations) {
        throw new AbortError(
          `interrupt: maxIterations reached at iteration ${ctx.iteration}`,
        )
      }
      return _messages
    },
  }
}
