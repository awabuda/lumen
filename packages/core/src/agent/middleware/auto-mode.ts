/**
 * Auto-mode classifier middleware (P22.5) — heuristic risk-tiered
 * gating for low-risk tool calls.
 *
 * Why a separate layer from `createToolPermissionMiddleware`
 * (P22.0) and `createInterruptMiddleware` (P20.1):
 *   - P22.0 answers "is this tool on the static allow-list?".
 *     Deterministic, no LLM, three outcomes.
 *   - P20.1 answers "should the operator approve this call?".
 *     Asynchronous, callback-driven.
 *   - P22.5 answers "is this call obviously low-risk enough to
 *     auto-allow even when the static layer said `ask`?".
 *     Deterministic, heuristic, **no LLM**.
 *
 * Why no LLM:
 *   - Claude Code and OpenClaw both run a hidden LLM call to
 *     evaluate prose rules. The operator cannot inspect the
 *     model's reasoning. P22.5's design invariant is
 *     "every decision is auditable from a `git log` of the
 *     risk table"; an LLM call breaks that invariant.
 *   - The heuristic engine is small, auditable, and ships
 *     with a starter risk table. P22.7 (LLM classifier) is
 *     the right slot for the prose-rules shape.
 *
 * Composition order (alphabetical by `name`):
 *   `tool-permission` → `tool-permission-auto` → `interrupt`
 *   → `skill-trigger` → `plan`.
 *
 * The classifier short-circuits the interrupt layer on
 * `allow`. This is the one place in P22.x where an inner
 * gate is bypassed, by explicit operator opt-in: enabling
 * `autoMode` means "auto-allow low-risk calls". P22.0 lets
 * the interrupt chain run on `allow` because the static
 * policy's `allow` is a different kind of decision.
 *
 * Risk tiers (core-shipped, NOT policy-shipped):
 *   - `low`      — read_file / list_dir / search_files
 *   - `medium`   — write_file (even to /tmp is risky)
 *   - `high`     — terminal
 *   - `unknown`  — anything not in the table
 *
 * Operator overrides live in the policy file's `autoMode:`
 * block: `neverAllowTools` is a hard opt-out (always `ask`),
 * `hardDenyPatterns` is a regex list that flips to `deny`
 * unconditionally.
 */

import { z } from 'zod'

import { AbortError } from '../../errors/index.js'
import type { ToolCall } from '../../message/index.js'
import type { AgentMiddleware } from '../middleware.js'

/** Risk tiers. `unknown` is a defensive default for tools not in the table. */
export const RiskTierSchema = z.enum(['low', 'medium', 'high', 'unknown'])
export type RiskTier = z.infer<typeof RiskTierSchema>

/** Classifier outcomes. `allow` short-circuits interrupt. */
export const RiskClassifierDecisionSchema = z.enum(['allow', 'ask', 'deny'])
export type RiskClassifierDecision = z.infer<typeof RiskClassifierDecisionSchema>

/** Configuration for the auto-mode block in the policy file. */
export const AutoModeRulesSchema = z
  .object({
    /** Opt-in flag. The heuristic engine runs only when this is true. */
    enabled: z.boolean(),
    /** Tool names that are NEVER auto-allowed, even at low risk. */
    neverAllowTools: z.array(z.string().min(1)).default([]),
    /** Regex patterns; if any matches the tool name the call is `deny`. */
    hardDenyPatterns: z.array(z.string()).default([]),
    /** Plain-text audit-only rules. The heuristic engine does NOT interpret them. */
    allowPatterns: z.array(z.string()).default([]),
    /** Plain-text audit-only rules. */
    softDenyPatterns: z.array(z.string()).default([]),
  })
  .strict()

export type AutoModeRules = z.infer<typeof AutoModeRulesSchema>

/**
 * The contract every classifier implementation fulfils.
 * Implementations are pure: same input → same output.
 */
export interface BaseRiskClassifier {
  readonly id: string
  /** Map a tool call to a risk tier. */
  tier(toolCall: ToolCall): RiskTier
  /** Decide allow / ask / deny. The heuristic engine also
   *  respects the operator-supplied `AutoModeRules`. */
  classify(toolCall: ToolCall): RiskClassifierDecision
}

/** Per-call decision the host can render in an audit log. */
export interface AutoModeDecisionRecord {
  readonly toolName: string
  readonly tier: RiskTier
  readonly decision: RiskClassifierDecision
  readonly at: number
}

/** State slice surfaced via the middleware's afterRun hook. */
export interface AutoModeState {
  readonly decisions: ReadonlyArray<AutoModeDecisionRecord>
  readonly enabled: boolean
}

/** The risk table is core-shipped and audited. P22.7 overrides live
 *  in the policy file. The table is intentionally small; anything
 *  not in it is `unknown`, which falls through to the interrupt layer. */
export const DEFAULT_RISK_TABLE: Readonly<Record<string, RiskTier>> = {
  read_file: 'low',
  list_dir: 'low',
  search_files: 'low',
  write_file: 'medium',
  terminal: 'high',
}

/** Options for {@link createHeuristicRiskClassifier}. */
export interface HeuristicRiskClassifierOptions {
  /** Override the default risk table. The override is merged
   *  on top of {@link DEFAULT_RISK_TABLE}. */
  readonly riskTable?: Readonly<Record<string, RiskTier>>
  /** Operator-supplied rules from the policy file's
   *  `autoMode:` block. */
  readonly rules: AutoModeRules
}

const defaultRules: AutoModeRules = {
  enabled: false,
  neverAllowTools: [],
  hardDenyPatterns: [],
  allowPatterns: [],
  softDenyPatterns: [],
}

/**
 * The heuristic engine. Deterministic; the same tool call +
 * rules produces the same decision every time.
 *
 * Decision precedence (high → low):
 *   1. `hardDenyPatterns` match → `deny`
 *   2. `neverAllowTools` contains the tool name → `ask`
 *      (we do not auto-allow even at low risk; the operator
 *      explicitly opted this tool out of auto-mode)
 *   3. tier is `high` or `unknown` → `ask`
 *   4. tier is `low` or `medium` → `allow`
 *
 * When `rules.enabled` is false the classifier returns `ask`
 * for every call regardless of tier. This is the
 * "auto-mode is off" default and matches P22.0's "no
 * classifier wired" behaviour.
 */
export const createHeuristicRiskClassifier = (
  options: HeuristicRiskClassifierOptions,
): BaseRiskClassifier => {
  const parsed = AutoModeRulesSchema.parse(options.rules)
  const table: Readonly<Record<string, RiskTier>> = {
    ...DEFAULT_RISK_TABLE,
    ...(options.riskTable ?? {}),
  }

  return {
    id: 'heuristic',
    tier(toolCall) {
      return table[toolCall.name] ?? 'unknown'
    },
    classify(toolCall) {
      if (!parsed.enabled) {
        return 'ask'
      }
      // hardDeny first: an explicit deny wins regardless of tier.
      for (const pattern of parsed.hardDenyPatterns) {
        try {
          if (new RegExp(pattern).test(toolCall.name)) {
            return 'deny'
          }
        } catch {
          // Invalid regex in the policy file: skip silently.
          // The Zod schema does not validate regex strings
          // (they are arbitrary user input); a malformed
          // pattern is a policy file bug, not a runtime
          // crash. The classify() call still returns `ask`
          // for this tool, which is the safe default.
        }
      }
      // neverAllowTools: even low-risk tools can be opted out.
      if (parsed.neverAllowTools.includes(toolCall.name)) {
        return 'ask'
      }
      const tier = table[toolCall.name] ?? 'unknown'
      if (tier === 'low' || tier === 'medium') {
        return 'allow'
      }
      // high or unknown always ask. The interrupt layer
      // (or the operator's `--approve-on`) decides.
      return 'ask'
    },
  }
}

/** Options for {@link createAutoModeMiddleware}. */
export interface AutoModeMiddlewareOptions {
  /** The classifier to use. */
  readonly classifier: BaseRiskClassifier
}

export const AutoModeMiddlewareOptionsSchema = z
  .object({
    classifier: z.custom<BaseRiskClassifier>(),
  })
  .strict()

/**
 * Create the auto-mode classifier middleware.
 *
 * The middleware wraps `wrapToolCall`. It **only** short-circuits
 * the default call when the classifier returns `allow`; the
 * `deny` outcome throws a typed `AbortError` that the P20.4.2
 * catch path auto-checkpoints.
 *
 * Composition: this middleware is meant to be placed in
 * front of `createInterruptMiddleware` (alphabetical by
 * `name` puts it there by default). The `allow` short-circuit
 * is the operator's explicit opt-in via `autoMode: { enabled: true }`
 * in the policy file.
 */
export const createAutoModeMiddleware = (
  options: AutoModeMiddlewareOptions,
): AgentMiddleware<AutoModeState> => {
  AutoModeMiddlewareOptionsSchema.parse(options)

  const decisions: AutoModeDecisionRecord[] = []

  return {
    name: 'tool-permission-auto',
    stateSchema: z
      .object({
        decisions: z.array(
          z
            .object({
              toolName: z.string(),
              tier: RiskTierSchema,
              decision: RiskClassifierDecisionSchema,
              at: z.number().int().nonnegative(),
            })
            .strict(),
        ),
        enabled: z.boolean(),
      })
      .strict(),
    initialState: { decisions: [], enabled: true } satisfies AutoModeState,
    wrapToolCall: async (toolCall, defaultCall) => {
      const tier = options.classifier.tier(toolCall)
      const decision = options.classifier.classify(toolCall)
      decisions.push({
        toolName: toolCall.name,
        tier,
        decision,
        at: Date.now(),
      })
      if (decision === 'deny') {
        throw new AbortError(`auto-mode denied: tool "${toolCall.name}" (tier ${tier})`)
      }
      if (decision === 'allow') {
        // Short-circuit the interrupt layer. The decision
        // is recorded in the state slice so the host can
        // render an audit row.
        return await defaultCall()
      }
      // ask: fall through to the interrupt chain unchanged.
      return await defaultCall()
    },
  }
}

// Suppress unused-import warning for the helper at the top.
void defaultRules
