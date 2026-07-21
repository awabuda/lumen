/**
 * ReflectionMiddleware (P19.2) — inline / step-level / run-end reflection.
 *
 * This lives in @lumen/core and intentionally does not import
 * @lumen/memory (tier isolation). Run-end persistence uses the
 * injected BaseMemoryStore already held by Agent.run; the middleware
 * itself only receives the final run result and writes a generic
 * reflection fact when a memory store is explicitly provided.
 */

import { z } from 'zod'
import type { BaseMemoryStore } from '../../memory/index.js'
import type { AssistantMessage, Message } from '../../message/index.js'
import type { AgentMiddleware, MiddlewareRunResult } from '../middleware.js'

/** Output of a reflection pass. */
export interface ReflectionResult {
  readonly confidence: number
  readonly summary: string
}

/** Config for {@link createReflectionMiddleware}. */
export interface ReflectionMiddlewareOptions {
  readonly inline?: boolean
  readonly stepInterval?: number
  readonly runEnd?: 'rule' | 'off'
  readonly memory?: BaseMemoryStore
}

/** Internal state for the reflection middleware. */
export interface ReflectionMiddlewareState {
  stepCount: number
  last?: ReflectionResult
}

const ReflectionStateSchema = z
  .object({
    stepCount: z.number().int().nonnegative(),
    last: z
      .object({
        confidence: z.number().min(0).max(1),
        summary: z.string(),
      })
      .optional(),
  })
  .strict()

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** Deterministic, no-LLM reflection heuristic. */
export const ruleBasedReflectMessages = (messages: ReadonlyArray<Message>): ReflectionResult => {
  const assistantCount = messages.filter((m) => m.role === 'assistant').length
  const toolCount = messages.filter((m) => m.role === 'tool').length
  const errorSignals = messages
    .map((m) => ('content' in m ? String(m.content) : ''))
    .filter((content) => /error|failed|exception/i.test(content)).length
  const confidence = clamp01(0.55 + toolCount * 0.08 + assistantCount * 0.03 - errorSignals * 0.12)
  const summary = `Reflected on ${messages.length} messages (${assistantCount} assistant, ${toolCount} tool).`
  return { confidence, summary }
}

const withInlineConfidence = (message: AssistantMessage, confidence: number): AssistantMessage => {
  const suffix = `[confidence: ${confidence.toFixed(2)}]`
  const content = message.content?.trim()
  return { ...message, content: content ? `${content} ${suffix}` : suffix }
}

const stateFrom = (state: unknown): ReflectionMiddlewareState => {
  ReflectionStateSchema.parse(state)
  return state as ReflectionMiddlewareState
}

/**
 * P23.3 — typed read/write seam for ReflectionMiddlewareState. The
 * pre-P23.3 pattern (`state.stepCount += 1`) bypassed the schema
 * guard; `set()` re-parses on every write so a shape violation
 * aborts the run.
 */
const stateViewFrom = (ctx: { readonly stateView?: Readonly<Record<string, unknown>> }): {
  current: ReflectionMiddlewareState
  set: (next: ReflectionMiddlewareState) => void
} => {
  const view = ctx.stateView?.reflection as
    | {
        current: ReflectionMiddlewareState
        set: (next: ReflectionMiddlewareState) => void
      }
    | undefined
  if (!view) {
    throw new Error(
      'ReflectionMiddleware requires ctx.stateView.reflection — agent.run must build the typed state surface (P23.3)',
    )
  }
  return { current: stateFrom(view.current), set: view.set }
}

const hashReflectionId = (sessionId: string, iterations: number): string =>
  `reflection-${sessionId}-${iterations}`

/** Create inline / step-level / run-end reflection middleware. */
export const createReflectionMiddleware = (
  options: ReflectionMiddlewareOptions = {},
): AgentMiddleware<ReflectionMiddlewareState> => {
  const inline = options.inline ?? true
  const stepInterval = options.stepInterval ?? 5
  const runEnd = options.runEnd ?? 'rule'

  return {
    name: 'reflection',
    stateSchema: ReflectionStateSchema,
    initialState: { stepCount: 0 },
    afterModel: (message, ctx) => {
      const { current: state, set } = stateViewFrom(ctx)
      const nextCount = state.stepCount + 1
      // P23.4 — reflection now reads the full conversation history
      // (prior turns + the just-produced message) so its signals
      // (assistant count, tool count, error-pattern frequency)
      // reflect the entire run, not the single turn. The
      // pre-P23.4 fallback `[message]` collapsed the whole run to
      // a single message and made every signal degenerate.
      const history =
        ctx.history ??
        (() => {
          throw new Error(
            'ReflectionMiddleware requires ctx.history — agent.run must attach the full conversation history (P23.4)',
          )
        })()
      const reflection = ruleBasedReflectMessages(history)
      const nextState: ReflectionMiddlewareState = {
        stepCount: nextCount,
        last: nextCount % stepInterval === 0 ? reflection : state.last,
      }
      set(nextState)
      return inline ? withInlineConfidence(message, reflection.confidence) : message
    },
    afterRun: async (result: MiddlewareRunResult, ctx) => {
      if (runEnd === 'off' || !options.memory) return
      // P23.4 — same full-history read on the afterRun hook.
      const history =
        ctx.history ??
        (() => {
          throw new Error(
            'ReflectionMiddleware requires ctx.history — agent.run must attach the full conversation history (P23.4)',
          )
        })()
      const reflection = ruleBasedReflectMessages(history)
      const { current: state, set } = stateViewFrom(ctx)
      set({ ...state, last: reflection })
      await options.memory.put({
        id: hashReflectionId(result.sessionId, result.iterations),
        kind: 'reflection',
        content: reflection.summary,
        trust: 0.5,
        tags: ['reflection', 'run-end'],
        metadata: {
          confidence: reflection.confidence,
          iterations: result.iterations,
        },
      })
    },
  }
}

/** Backwards-friendly alias for object-style imports. */
export const ReflectionMiddleware = createReflectionMiddleware
