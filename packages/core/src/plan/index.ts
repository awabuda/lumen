/**
 * Plan/act mode — separates planning from execution.
 *
 * P19.1 refactor note:
 *   The original P9.5/P12.5 implementation exported an abstract
 *   `BasePlanner` class plus `StaticPlanner` / `LLMPlanner` classes.
 *   P19+ rule 15 replaces that pattern with an interface + helper
 *   functions: helper function > abstract class, and abstract classes
 *   need at least two non-wrapper implementations to justify the
 *   inheritance cost. Planner implementations are plain objects now.
 *
 * Wire-up note:
 *   This module owns data structures and planner helpers only.
 *   Agent.run integration happens through `PlanMiddleware`
 *   (P19.1.2/P19.1.3), not by adding boolean flags to AgentConfig.
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
export const PlanStepSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    tools: z.array(z.string()).optional(),
    dependsOn: z.array(z.string()).optional(),
  })
  .strict()

/** Zod schema for {@link Plan}. */
export const PlanSchema = z
  .object({
    id: z.string().min(1),
    goal: z.string().min(1),
    steps: z.array(PlanStepSchema).min(1),
    createdAt: z.number().int().nonnegative(),
    approvedAt: z.number().int().nonnegative().optional(),
    rejectedAt: z.number().int().nonnegative().optional(),
    notes: z.string().optional(),
  })
  .strict()

/** The agent's current mode. */
export type Mode = 'plan' | 'act' | 'auto'

/** Zod schema for {@link Mode}. */
export const ModeSchema = z.enum(['plan', 'act', 'auto'])

/** The contract every planner implementation fulfills. */
export interface BasePlanner {
  /** Stable identifier. */
  readonly id: string

  /**
   * Given a goal, produce a structured plan. Does NOT invoke tools.
   * Throws on failure (Rule 7).
   */
  plan(goal: string): Promise<Plan>

  /**
   * Optionally revise an existing plan based on user feedback.
   * Implementations may omit this; callers use {@link revisePlan}
   * for the default unchanged-plan behavior.
   */
  revise?: (plan: Plan, feedback: string) => Promise<Plan>
}

/** Default planner revision behavior: return the plan unchanged. */
export const revisePlan = async (
  planner: BasePlanner,
  plan: Plan,
  feedback: string,
): Promise<Plan> => {
  return planner.revise ? planner.revise(plan, feedback) : plan
}

// ---------------------------------------------------------------------------
// Static planner helper — for testing and scripted plans
// ---------------------------------------------------------------------------

/** Options for {@link createStaticPlanner}. */
export interface StaticPlannerOptions {
  /** The plan to return. */
  readonly plan: Plan
}

/** Returns a fixed plan. Useful for testing. */
export const createStaticPlanner = (options: StaticPlannerOptions): BasePlanner => {
  const plan = PlanSchema.parse(options.plan)
  return {
    id: 'static',
    async plan(_goal: string): Promise<Plan> {
      return plan
    },
    async revise(current: Plan, _feedback: string): Promise<Plan> {
      return current
    },
  }
}

/** Backwards-compatible function alias for the old class export name. */
export const StaticPlanner = createStaticPlanner

// ---------------------------------------------------------------------------
// LLM planner helper — asks the LLM to generate a plan
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
export const LLMPlannerOptionsSchema = z
  .object({
    provider: z.custom<MinimalProvider>((v) => typeof v === 'object' && v !== null),
    model: z.string().min(1).optional(),
  })
  .strict()

/** Options for {@link createLLMPlanner}. */
export type LLMPlannerOptions = z.input<typeof LLMPlannerOptionsSchema>

/** Default model for planning. */
const DEFAULT_PLAN_MODEL = 'gpt-4o-mini'

/** Extract JSON from an LLM response that may include prose. */
export const extractPlanJson = (text: string): string => {
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

/** Normalize + validate step ids from an LLM response. */
export const parsePlanSteps = (
  steps: ReadonlyArray<Partial<PlanStep>>,
): ReadonlyArray<PlanStep> => {
  return steps.map((s, i) => PlanStepSchema.parse({ ...s, id: s.id ?? `step-${i + 1}` }))
}

/** Asks the LLM to generate a structured plan as JSON. */
export const createLLMPlanner = (options: LLMPlannerOptions): BasePlanner => {
  const parsedOptions = LLMPlannerOptionsSchema.parse(options)
  const provider = parsedOptions.provider
  const model = parsedOptions.model ?? DEFAULT_PLAN_MODEL

  const planner: BasePlanner = {
    id: 'llm',
    async plan(goal: string): Promise<Plan> {
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

      const response = await provider.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      })

      const raw = extractPlanJson(response.content)
      const parsed = JSON.parse(raw) as { steps: Array<Partial<PlanStep>> }
      const steps = parsePlanSteps(parsed.steps)

      return PlanSchema.parse({
        id: `plan-${Date.now()}`,
        goal,
        steps,
        createdAt: Date.now(),
      })
    },
    async revise(plan: Plan, feedback: string): Promise<Plan> {
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

      const response = await provider.chat({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      })

      const raw = extractPlanJson(response.content)
      const parsed = JSON.parse(raw) as { steps: Array<Partial<PlanStep>> }
      const steps = parsePlanSteps(parsed.steps)

      return PlanSchema.parse({
        id: plan.id,
        goal: plan.goal,
        steps,
        createdAt: plan.createdAt,
      })
    },
  }

  return planner
}

/** Backwards-compatible function alias for the old class export name. */
export const LLMPlanner = createLLMPlanner

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

  /**
   * Serialize every plan to a plain JSON-serializable array. Used by
   * CLI commands to persist PlanStore to a file across process
   * restarts (e.g. `~/.lumen/plans.json`).
   */
  public toJSON(): ReadonlyArray<Plan> {
    return [...this.plans.values()].map((plan) => PlanSchema.parse(plan))
  }

  /**
   * Hydrate the store from a serialized payload (e.g. read back from
   * a JSON file). Existing entries with the same id are overwritten;
   * the store is **not** cleared first — callers that want a
   * from-scratch store should construct a new `PlanStore` instance.
   */
  public hydrate(plans: ReadonlyArray<Plan>): void {
    for (const raw of plans) {
      const plan = PlanSchema.parse(raw)
      this.plans.set(plan.id, plan)
    }
  }
}
