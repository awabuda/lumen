/**
 * PlanMiddleware (P19.1) — plan / act / auto orchestration.
 *
 * This is intentionally implemented as AgentMiddleware, not as
 * `AgentConfig.enablePlan` / `AgentConfig.mode` boolean soup. The
 * middleware owns the state slice and uses the small
 * MiddlewareControl surface (`continueAfterModel`) to implement
 * auto plan -> act continuation.
 */

import { z } from 'zod'
import {
  type BasePlanner,
  type Mode,
  type Plan,
  PlanSchema,
  type PlanStore,
} from '../../plan/index.js'
import type { AgentMiddleware } from '../middleware.js'

/** PlanMiddleware state: internal to one Agent.run call. */
export interface PlanMiddlewareState {
  readonly mode: Mode
  phase: 'planning' | 'acting' | 'done'
  plan?: Plan
  goal?: string
}

/** Options for {@link createPlanMiddleware}. */
export interface PlanMiddlewareOptions {
  readonly mode: Mode
  readonly planner?: BasePlanner
  readonly planStore?: PlanStore
}

const PlanMiddlewareStateSchema = z
  .object({
    mode: z.enum(['plan', 'act', 'auto']),
    phase: z.enum(['planning', 'acting', 'done']),
    plan: PlanSchema.optional(),
    goal: z.string().optional(),
  })
  .strict()

const PLAN_PROMPT = [
  'You are in plan mode.',
  'Generate a concise execution plan and do not call tools.',
  'Wrap the plan in this exact XML shape:',
  '<plan id="plan-1">',
  '- step-1: ...',
  '- step-2: ...',
  '</plan>',
  'After the closing tag, stop.',
].join('\n')

const planToContext = (plan: Plan): string =>
  [
    'Approved plan for this task:',
    `<plan id="${plan.id}">`,
    ...plan.steps.map((s) => `- ${s.id}: ${s.description}`),
    '</plan>',
    'Execute the task according to the approved plan. You may call tools if needed.',
  ].join('\n')

const parsePlanFromText = (goal: string, text: string): Plan | undefined => {
  const match = /<plan id="([^"]+)">([\s\S]*?)<\/plan>/m.exec(text)
  if (!match) return undefined
  const id = match[1]
  const body = match[2]
  if (!id || !body) return undefined
  const steps = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, i) => {
      const withoutBullet = line.replace(/^[-*]\s*/, '')
      const [maybeId, ...rest] = withoutBullet.split(':')
      const idFromLine = maybeId?.trim() || `step-${i + 1}`
      const description = rest.join(':').trim() || withoutBullet
      return { id: idFromLine, description }
    })

  if (steps.length === 0) return undefined
  return PlanSchema.parse({
    id,
    goal,
    steps,
    createdAt: Date.now(),
  })
}

const stateFrom = (state: unknown): PlanMiddlewareState => {
  PlanMiddlewareStateSchema.parse(state)
  return state as PlanMiddlewareState
}

/** Create a plan/act/auto middleware instance. */
export const createPlanMiddleware = (
  options: PlanMiddlewareOptions,
): AgentMiddleware<PlanMiddlewareState> => {
  const initialPhase: PlanMiddlewareState['phase'] = options.mode === 'act' ? 'acting' : 'planning'
  const initialState: PlanMiddlewareState = { mode: options.mode, phase: initialPhase }

  return {
    name: 'plan',
    stateSchema: PlanMiddlewareStateSchema,
    initialState,
    beforeModel: async (messages, ctx) => {
      const state = stateFrom(ctx.state.plan)
      if (state.mode === 'act') return messages
      if (state.phase === 'planning') {
        if (options.planner) {
          const user = [...messages].reverse().find((m) => m.role === 'user')
          const goal = user && 'content' in user ? String(user.content) : 'plan task'
          state.goal = goal
          const plan = await options.planner.plan(goal)
          state.plan = plan
          state.phase = state.mode === 'auto' ? 'acting' : 'done'
          options.planStore?.save(plan)
          if (state.mode === 'auto') {
            ctx.control.continueAfterModel = true
          }
          return [...messages, { role: 'system', content: planToContext(plan) }]
        }
        state.goal = [...messages]
          .reverse()
          .find((m) => m.role === 'user' && 'content' in m)
          ?.content.toString()
        return [...messages, { role: 'system', content: PLAN_PROMPT }]
      }
      if (state.mode === 'auto' && state.phase === 'acting' && state.plan) {
        state.phase = 'done'
        return [...messages, { role: 'system', content: planToContext(state.plan) }]
      }
      return messages
    },
    afterModel: (response, ctx) => {
      const state = stateFrom(ctx.state.plan)
      if (state.mode === 'act') return response
      if (state.phase !== 'planning') return response

      const goal = state.goal ?? 'plan task'
      const plan = parsePlanFromText(goal, response.content ?? '')
      if (plan) {
        state.plan = plan
        options.planStore?.save(plan)
      }

      // Plan mode must not execute tools even if the model tried.
      const planned = { ...response, toolCalls: [] }
      state.phase = state.mode === 'auto' ? 'acting' : 'done'
      if (state.mode === 'auto') {
        ctx.control.continueAfterModel = true
      }
      return planned
    },
  }
}

/** Backwards-friendly alias for object-style imports. */
export const PlanMiddleware = createPlanMiddleware
