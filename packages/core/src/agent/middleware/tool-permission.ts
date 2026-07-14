/**
 * Permission policy middleware (P22) — static, deterministic tool-call
 * gating.
 *
 * Why a separate layer from `createInterruptMiddleware`:
 *   - Permission decisions are **deterministic**: a YAML rule
 *     matches or it does not. There is no human in the loop.
 *   - Interrupt decisions are **asynchronous**: they may need
 *     operator approval via the `approve` callback (P20.1.2).
 *   - The two layers compose. Permission runs first; if the
 *     outcome is `ask`, the call falls through to interrupt.
 *     If the outcome is `allow`, the call dispatches without
 *     touching the interrupt middleware. If the outcome is
 *     `deny`, the call aborts with a typed `AbortError` that
 *     the P20.4.2 catch path can auto-checkpoint.
 *
 * Why no LLM in this layer:
 *   - The framework's promise to operators is "every decision
 *     in the policy file is auditable from `git log`". An
 *     LLM-based classifier breaks that promise (the LLM
 *     weights, the prompt, the temperature — all hidden
 *     inputs to the decision).
 *   - The OpenClaw / Claude Code public surfaces for permission
 *     modes are also static and deterministic. This is the
 *     industry default. P22.5 (auto mode) is the place to
 *     consider a classifier; it is intentionally deferred.
 *
 * Composition order:
 *   The CLI composition sorts middleware by `name`. The
 * permission middleware's `name` is `'tool-permission'`; the
 * interrupt middleware's is `'interrupt'`. Alphabetical sort
 * puts permission first, which is what we want.
 */

import { z } from 'zod'

import { AbortError } from '../../errors/index.js'
import type { ToolCall } from '../../message/index.js'
import type { AgentMiddleware } from '../middleware.js'

/** The three outcomes a permission rule can produce. */
export const ToolPermissionDecisionSchema = z.enum(['allow', 'deny', 'ask'])
export type ToolPermissionDecision = z.infer<typeof ToolPermissionDecisionSchema>

/**
 * Optional condition that must hold for a rule to apply. `argMatches`
 * is a `Record<argKey, regex>`; a tool call's `arguments` are matched
 * against the regex string via `RegExp.test(valueAsString)`. The
 * rule fires only when **every** entry matches. A rule with no
 * `when` matches the tool call purely on tool name.
 */
export const ToolPermissionWhenSchema = z
  .object({
    argMatches: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .optional()

/** A single rule in the policy file. */
export const ToolPermissionRuleSchema = z
  .object({
    /** Human-readable label, surfaced in deny messages and audit rows. */
    name: z.string().min(1),
    /** Tool names this rule applies to. Matched by exact string compare. */
    tools: z.array(z.string().min(1)).min(1),
    /** Outcome the rule produces when it fires. */
    decision: ToolPermissionDecisionSchema,
    /** Optional condition on the tool call's arguments. */
    when: ToolPermissionWhenSchema,
  })
  .strict()

/** P22.5.2 — auto-mode block. Optional. When omitted the
 *  classifier middleware is not wired (default: ask for every
 *  tool call). Mirrors the `AutoModeRulesSchema` in
 *  `./auto-mode.ts`; defined inline here to avoid a
 *  cross-import between the two middleware files (the
 *  composition root parses the policy once and threads the
 *  block into the auto-mode middleware). */
const AutoModePolicyBlockSchema = z
  .object({
    enabled: z.boolean(),
    neverAllowTools: z.array(z.string().min(1)).default([]),
    hardDenyPatterns: z.array(z.string()).default([]),
    allowPatterns: z.array(z.string()).default([]),
    softDenyPatterns: z.array(z.string()).default([]),
  })
  .strict()

/** Top-level policy file. */
export const ToolPermissionPolicySchema = z
  .object({
    /** Schema version. Bump when the shape changes. */
    version: z.literal(1),
    /** Decision when no rule matches. */
    default: ToolPermissionDecisionSchema,
    /** Ordered list of rules; first match wins. */
    rules: z.array(ToolPermissionRuleSchema),
    /**
     * P22.5.2: optional auto-mode block. When set, the
     * composition root wires `createAutoModeMiddleware`
     * with the heuristic engine. When omitted (the default),
     * auto-mode is off and every `ask` decision falls
     * through to the interrupt layer unchanged.
     */
    autoMode: AutoModePolicyBlockSchema.optional(),
  })
  .strict()

export type ToolPermissionRule = z.infer<typeof ToolPermissionRuleSchema>
export type ToolPermissionPolicy = z.infer<typeof ToolPermissionPolicySchema>

/** The contract every policy implementation fulfils. */
export interface BaseToolPermissionPolicy {
  readonly id: string
  evaluate(toolCall: ToolCall): ToolPermissionDecision
}

/** Single entry the host can render in an audit row. */
export interface ToolPermissionDecisionRecord {
  readonly toolName: string
  readonly decision: ToolPermissionDecision
  readonly ruleName?: string
  readonly at: number
}

/** State slice surfaced via the middleware's afterRun hook. */
export interface ToolPermissionState {
  readonly decisions: ReadonlyArray<ToolPermissionDecisionRecord>
}

/** Max rules per policy file. The dispatcher is O(rules) per tool call. */
export const TOOL_PERMISSION_MAX_RULES = 1000

/**
 * Stringify a tool call argument value for regex matching. Numbers and
 * booleans are coerced to their string form; objects are JSON-stringified
 * (stable because both sides use canonical JSON). `undefined` becomes
 * the empty string so an `argMatches` rule against a missing arg does
 * not match accidentally.
 */
const stringifyArg = (value: unknown): string => {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Plain-data policy implementation. Rules are evaluated in order. */
export const createStaticToolPermissionPolicy = (
  policy: ToolPermissionPolicy,
): BaseToolPermissionPolicy => {
  ToolPermissionPolicySchema.parse(policy)
  if (policy.rules.length > TOOL_PERMISSION_MAX_RULES) {
    throw new Error(
      `createStaticToolPermissionPolicy: too many rules (${policy.rules.length}; max ${TOOL_PERMISSION_MAX_RULES})`,
    )
  }

  return {
    id: 'static',
    evaluate(toolCall) {
      for (const rule of policy.rules) {
        if (!rule.tools.includes(toolCall.name)) continue
        if (rule.when?.argMatches) {
          const args = (toolCall.arguments ?? {}) as Record<string, unknown>
          const matches = Object.entries(rule.when.argMatches).every(([key, pattern]) => {
            const value = stringifyArg(args[key])
            try {
              return new RegExp(pattern).test(value)
            } catch {
              return false
            }
          })
          if (!matches) continue
        }
        return rule.decision
      }
      return policy.default
    },
  }
}

/** Options for {@link createToolPermissionMiddleware}. */
export interface ToolPermissionMiddlewareOptions {
  readonly policy: BaseToolPermissionPolicy
}

export const ToolPermissionMiddlewareOptionsSchema = z
  .object({
    policy: z.custom<BaseToolPermissionPolicy>(),
  })
  .strict()

/**
 * Create the permission policy middleware.
 *
 * The middleware wraps `wrapToolCall`. On every dispatch:
 *   - `allow`: dispatch via `defaultCall()`. The remaining
 *     middleware in the chain (notably the interrupt
 *     middleware, if any) still run; this layer is a
 *     **deny-only gate**, not a short-circuit. The decision
 *     log records the `allow` so the host can audit it.
 *   - `deny`: throw `AbortError('permission denied: <rule name>')`
 *     without calling `defaultCall()`. The P20.4.2 catch path
 *     auto-saves a checkpoint (the deny abort is still an
 *     AbortError, so the catch path fires; an opt-out
 *     `checkpointOnDeny: false` knob is left as a P22.0
 *     follow-up if operators report the audit gap).
 *   - `ask`: dispatch via `defaultCall()`. The host's
 *     `createInterruptMiddleware({ toolNames, approve })` chain
 *     decides whether the call actually dispatches.
 *
 * P22.0 does **not** short-circuit the interrupt middleware on
 * `allow`. The rationale: the middleware chain is a linear
 * `await next() → wrap` pipeline, and an outer middleware has
 * no way to ask the inner layer to skip itself. Permission
 * `allow` records the decision and lets the inner chain
 * proceed unchanged. P22.5 (auto-mode) is the right place
 * to revisit the chain-skipping design.
 *
 * Every decision (allow / deny / ask) is recorded in the
 * middleware's `ToolPermissionState.decisions` slice so the host
 * can render an audit row after the run.
 */
export const createToolPermissionMiddleware = (
  options: ToolPermissionMiddlewareOptions,
): AgentMiddleware<ToolPermissionState> => {
  ToolPermissionMiddlewareOptionsSchema.parse(options)

  const decisions: ToolPermissionDecisionRecord[] = []

  return {
    name: 'tool-permission',
    stateSchema: z
      .object({
        decisions: z.array(
          z
            .object({
              toolName: z.string(),
              decision: ToolPermissionDecisionSchema,
              ruleName: z.string().optional(),
              at: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    initialState: { decisions: [] } satisfies ToolPermissionState,
    wrapToolCall: async (toolCall, defaultCall) => {
      const decision = options.policy.evaluate(toolCall)
      const record: ToolPermissionDecisionRecord = {
        toolName: toolCall.name,
        decision,
        at: Date.now(),
      }
      decisions.push(record)
      if (decision === 'deny') {
        throw new AbortError(`permission denied: tool "${toolCall.name}"`)
      }
      // allow and ask: fall through to the next middleware
      // (notably the interrupt middleware, if present). The
      // interrupt layer can still abort the call.
      return await defaultCall()
    },
  }
}
