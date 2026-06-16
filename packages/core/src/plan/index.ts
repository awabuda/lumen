/**
 * Plan/act mode — separates reasoning from execution.
 *
 * In **plan mode**, the agent reasons about a task and
 * produces a structured plan but does not invoke tools.
 * The user reviews the plan and approves, modifies, or
 * rejects it.
 *
 * In **act mode**, the agent executes the approved plan,
 * optionally with tool calls.
 *
 * This module provides the data structures and the
 * {@link BasePlanner} contract. The agent loop reads the
 * current mode from config and dispatches accordingly.
 *
 * Why a separate module:
 *   Plan/act is orthogonal to the agent loop. It can be
 *   implemented as a hook, a sub-mode of Agent.run, or a
 *   separate Agent subclass (via composition, not
 *   inheritance — see Agent JSDoc).
 */

import { z } from 'zod'
import { ProviderError } from '../errors/index.js'

/** A single step in a plan. */
export interface PlanStep {
  /** Unique identifier within the plan (e.g. 'step-1'). */
  readonly id: string
  /** What this step does. */
  readonly description: string
  /** Tools this step will use. */
  readonly tools?: ReadonlyArray<string>
  /** Whether this step depends on the previous one. */
  readonly dependsOn?: ReadonlyArray<string>
}

/** A complete plan produced by the agent. */
export interface Plan {
  /** Stable identifier. */
  readonly id: string
  /** The goal the plan addresses. */
  readonly goal: string
  /** Ordered list of steps. */
  readonly steps: ReadonlyArray<PlanStep>
  /** When the plan was created (epoch ms). */
  readonly createdAt: number
  /** When the plan was approved (epoch ms), if approved. */
  readonly approvedAt?: number
  /** When the plan was rejected (epoch ms), if rejected. */
  readonly rejectedAt?: number
  /** Free-form notes from the approver. */
  readonly notes?: string
}

/** Zod schema for {@link PlanStep}. */
export const PlanStepSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string()).optional(),
  dependsOn: z.array(z.string()).optional(),
})

/** Zod schema for {@link Plan}. */
export const PlanSchema = z.object({
  id: z.string().min(1),
  goal: z.string().min(1),
  steps: z.array(PlanStepSchema).min(1),
  createdAt: z.number().int().nonnegative(),
  approvedAt: z.number().int().nonnegative().optional(),
  rejectedAt: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
})

/** The agent's current mode. */
export type Mode = 'plan' | 'act'

/** Zod schema for {@link Mode}. */
export const ModeSchema = z.enum(['plan', 'act'])

/** The contract every planner implementation fulfills. */
export abstract class BasePlanner {
  /** Stable identifier. */
  public abstract readonly id: string

  /**
   * Given a goal, produce a structured plan. Does NOT
   * invoke tools. Throws on failure (Rule 7).
   */
  public abstract plan(goal: string): Promise<Plan>

  /**
   * Optionally revise an existing plan based on user
   * feedback. Default impl returns the original plan
   * unchanged.
   */
  public async revise(plan: Plan, _feedback: string): Promise<Plan> {
    return plan
  }
}

// ---------------------------------------------------------------------------
// StaticPlanner — for testing and scripted plans
// ---------------------------------------------------------------------------

/** Options for {@link StaticPlanner}. */
export interface StaticPlannerOptions {
  /** The plan to return. */
  readonly plan: Plan
}

/** Returns a fixed plan. Useful for testing. */
export class StaticPlanner extends BasePlanner {
  public readonly id = 'static'
  private readonly _plan: Plan

  public constructor(options: StaticPlannerOptions) {
    super()
    this._plan = options.plan
  }

  public override async plan(_goal: string): Promise<Plan> {
    return this._plan
  }
}

// ---------------------------------------------------------------------------
// LLMPlanner — asks the LLM to generate a plan
// ---------------------------------------------------------------------------

/** Minimal provider shape — mirrors @lumen/core's BaseProvider. */
interface MinimalProvider {
  chat(opts: {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }): Promise<{ content: string }>
}

/** Zod schema for {@link LLMPlannerOptions}. */
export const LLMPlannerOptionsSchema = z.object({
  provider: z.custom<MinimalProvider>((v) => typeof v === 'object' && v !== null),
  model: z.string().min(1).optional(),
})

/** Options for {@link LLMPlanner}. */
export type LLMPlannerOptions = z.input<typeof LLMPlannerOptionsSchema>

/** Default model for planning. */
const DEFAULT_PLAN_MODEL = 'gpt-4o-mini'

/** Asks the LLM to generate a structured plan as JSON. */
export class LLMPlanner extends BasePlanner {
  public readonly id = 'llm'
  private readonly provider: MinimalProvider
  private readonly model: string

  public constructor(options: LLMPlannerOptions) {
    super()
    LLMPlannerOptionsSchema.parse(options)
    this.provider = options.provider
    this.model = options.model ?? DEFAULT_PLAN_MODEL
  }

  public async plan(goal: string): Promise<Plan> {
    const prompt = [
      'You are a planning agent. Given a goal, produce a',
      'JSON plan with this exact shape:',
      '{',
      '  "steps": [',
      '    {',
      '      "id": "step-1",',
      '      "description": "...",',
      '      "tools": ["..."],  // optional',
      '      "dependsOn": ["..."]  // optional',
      '    }',
      '  ]',
      '}',
      '',
      `Goal: ${goal}`,
      '',
      'Respond with ONLY the JSON object, no markdown fences.',
    ].join('\n')

    const response = await this.provider.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    })

    const raw = this.extractJson(response.content)
    const parsed = JSON.parse(raw) as { steps: PlanStep[] }

    // Validate each step.
    const steps: PlanStep[] = parsed.steps.map((s, i) =>
      PlanStepSchema.parse({ ...s, id: s.id ?? `step-${i + 1}` }),
    )

    return PlanSchema.parse({
      id: `plan-${Date.now()}`,
      goal,
      steps,
      createdAt: Date.now(),
    })
  }

  public override async revise(plan: Plan, feedback: string): Promise<Plan> {
    const prompt = [
      'You are revising a plan based on user feedback.',
      'Current plan:',
      JSON.stringify(plan, null, 2),
      '',
      'Feedback:',
      feedback,
      '',
      'Respond with the revised plan as JSON only.',
    ].join('\n')

    const response = await this.provider.chat({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
    })

    const raw = this.extractJson(response.content)
    const parsed = JSON.parse(raw) as { steps: PlanStep[] }
    const steps = parsed.steps.map((s, i) =>
      PlanStepSchema.parse({ ...s, id: s.id ?? `step-${i + 1}` }),
    )

    return PlanSchema.parse({
      id: plan.id,
      goal: plan.goal,
      steps,
      createdAt: plan.createdAt,
    })
  }

  /** Extract JSON from an LLM response that may include prose. */
  private extractJson(text: string): string {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) {
      throw new ProviderError('No JSON object found in LLM response', {
        providerId: 'plan',
        retryable: false,
      })
    }
    return text.slice(start, end + 1)
  }
}

// ---------------------------------------------------------------------------
// PlanStore — in-memory plan persistence
// ---------------------------------------------------------------------------

/** Storage for plans keyed by plan id. */
export class PlanStore {
  private readonly plans: Map<string, Plan> = new Map()

  /** Persist a plan. */
  public save(plan: Plan): Plan {
    PlanSchema.parse(plan)
    this.plans.set(plan.id, plan)
    return plan
  }

  /** Get a plan by id. */
  public get(id: string): Plan | undefined {
    return this.plans.get(id)
  }

  /** Mark a plan as approved. */
  public approve(id: string, notes?: string): Plan | undefined {
    const plan = this.plans.get(id)
    if (!plan) return undefined
    const updated: Plan = { ...plan, approvedAt: Date.now(), ...(notes ? { notes } : {}) }
    this.plans.set(id, updated)
    return updated
  }

  /** Mark a plan as rejected. */
  public reject(id: string, notes?: string): Plan | undefined {
    const plan = this.plans.get(id)
    if (!plan) return undefined
    const updated: Plan = { ...plan, rejectedAt: Date.now(), ...(notes ? { notes } : {}) }
    this.plans.set(id, updated)
    return updated
  }

  /** Number of stored plans. */
  public get size(): number {
    return this.plans.size
  }

  /** All stored plans. */
  public get all(): ReadonlyArray<Plan> {
    return [...this.plans.values()]
  }
}
