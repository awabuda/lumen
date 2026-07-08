/**
 * Skill trigger middleware (P20.6) — lazy skill activation based
 * on user message content.
 *
 * Borrowed shape from LangChain 1.0's `SkillsMiddleware` /
 * deepagents' "load skills on demand" pattern: instead of
 * attaching every registered skill to the system prompt at
 * startup, the agent loop evaluates a **trigger** on each new
 * user message and only loads the matching skills into the
 * context window.
 *
 * Why a middleware:
 *   - The activation policy is **what** triggers and **how** to
 *     format the system-prompt augmentation. P19+ rule 11 says
 *     policy on the agent loop = middleware; rule 15 says
 *     helper function + interface, not abstract class.
 *
 * Why a callable trigger (not a class):
 *   - The caller already has a `SkillRegistry` from
 *     `@lumen/skills` (which lives in a different tier). The
 *     middleware stays tier-agnostic by accepting a plain
 *     function `(userMessage) => Promise<ActivatedSkill[]>`
 *     that the caller composes from whatever trigger strategy
 *     they use. The core package does not import skills.
 *
 * Why `beforeModel` (not `wrapModelCall`):
 *   - The hook returns the modified `messages` array; the agent
 *     loop calls the provider with the augmented system prompt.
 *   - Same shape as P20.3 context compression.
 */

import { z } from 'zod'

import type { AgentMiddleware } from '../middleware.js'
import type { Message } from '../../message/index.js'

/** Minimum descriptor a caller has to surface for each active skill. */
export const ActiveSkillSchema = z
  .object({
    /** Stable skill id. */
    id: z.string().min(1),
    /** Human-readable name. */
    name: z.string().min(1),
    /** Short description; rendered into the system-prompt augmentation. */
    description: z.string().min(1),
    /** Optional trigger score in [0, 1]. */
    score: z.number().min(0).max(1).optional(),
  })
  .strict()

export type ActiveSkill = z.infer<typeof ActiveSkillSchema>

/** Strategy the middleware uses to decide which skills to activate. */
export type SkillTriggerFn = (
  userMessage: string,
) => Promise<ReadonlyArray<ActiveSkill>>

/** Configurable rule set. */
export const SkillTriggerOptionsSchema = z
  .object({
    /** Trigger function. Called once per user turn. */
    trigger: z.function().args(z.string()).returns(z.promise(z.array(ActiveSkillSchema))),
    /**
     * Maximum number of skills to activate per turn. The
     * trigger's results are truncated to this size. Defaults
     * to 3 — the rest of the system prompt is more important.
     */
    maxActive: z.number().int().positive().optional(),
    /**
     * Optional custom formatter. The default is a plain bullet
     * list. Callers who want richer rendering (markdown table,
     * collapsible section, etc.) pass their own.
     */
    formatActive: z.function().args(z.array(ActiveSkillSchema)).returns(z.string()).optional(),
  })
  .strict()

export type SkillTriggerOptions = z.infer<typeof SkillTriggerOptionsSchema>

/** State slice (intentionally empty — the trigger is stateless). */
export type SkillTriggerState = Record<string, never>

const DEFAULT_MAX_ACTIVE = 3
const DEFAULT_FORMAT = (skills: ReadonlyArray<ActiveSkill>): string => {
  if (skills.length === 0) return ''
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`)
  return `[Active skills]\n${lines.join('\n')}`
}

/**
 * Create a skill-trigger middleware.
 *
 * Algorithm:
 *   1. Pull the last user message from the messages array.
 *   2. Invoke the trigger function with that message.
 *   3. Truncate the result to `maxActive`.
 *   4. Format the active skills into a system-role message and
 *      prepend it to the messages array.
 *
 * If the last message is not a user message, the middleware
 * is a pass-through (skill activation is user-driven; tool
 * calls and assistant messages do not trigger re-activation).
 */
export const createSkillTriggerMiddleware = (
  options: SkillTriggerOptions,
): AgentMiddleware<SkillTriggerState> => {
  const parsed = SkillTriggerOptionsSchema.parse(options)
  const maxActive = parsed.maxActive ?? DEFAULT_MAX_ACTIVE
  const format = parsed.formatActive ?? DEFAULT_FORMAT

  return {
    name: 'skill-trigger',
    stateSchema: z.object({}).strict(),
    initialState: {},
    beforeModel: async (messages) => {
      // Find the most recent user message.
      let lastUser: Message | undefined
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i]
        if (m && m.role === 'user') {
          lastUser = m
          break
        }
      }
      if (!lastUser) return messages
      // Only 'user' messages carry a string content in this
      // model; tool-result user messages are filtered out by
      // the role check above.
      const userText = 'content' in lastUser ? String(lastUser.content) : ''
      if (userText.length === 0) return messages

      const triggered = await parsed.trigger(userText)
      const active = triggered.slice(0, maxActive)
      if (active.length === 0) return messages

      const formatted = format(active)
      if (formatted.length === 0) return messages

      const augmentation: Message = {
        role: 'system',
        content: formatted,
      }
      return [augmentation, ...messages]
    },
  }
}
