/**
 * Quality score helpers (P19.7.5).
 *
 * Bench reports (P19.7.1-4) record wall-clock latency. Operators
 * also want a quality axis (LangSmith-style) so a regression in
 * "fast but wrong" can be caught by the same report.
 *
 * Three scores, all rule-based (no LLM, deterministic, e2e-safe):
 *   - `planCoverage` ∈ [0, 1]: fraction of `lumen plan` plans
 *     whose steps cover the goal string. A plan with steps that
 *     share zero tokens with the goal scores 0; a plan whose
 *     steps share all goal tokens scores 1.
 *   - `reflectionConfidence` ∈ [0, 1]: the most-recent inline
 *     reflection's confidence value (read from
 *     `[confidence: 0.XX]` suffix or rule-based heuristic).
 *   - `subagentCoordination` ∈ [0, 1]: 1.0 if all sub-agents
 *     returned non-empty final messages; 0.0 if any returned
 *     empty; intermediate for partial failures.
 *
 * Why rule-based and not LLM-as-judge:
 *   - LLM-as-judge adds API cost + non-determinism. The bench
 *     harness is supposed to be reproducible.
 *   - Lumen rule-based scores are pessimistic but consistent;
 *     a 0.7 from this module is "the heuristic thinks 70% of
 *     the plan covers the goal" — a stable signal over time.
 *
 * P19.7.5 scope: helpers + one demo bench that prints quality
 * alongside latency. Real bench integration (07/08 adding a
 * quality column) is left to P20+ when the helpers stabilise.
 */

import { z } from 'zod'

export const QualityScoresSchema = z
  .object({
    planCoverage: z.number().min(0).max(1),
    reflectionConfidence: z.number().min(0).max(1),
    subagentCoordination: z.number().min(0).max(1),
  })
  .strict()

export type QualityScores = z.infer<typeof QualityScoresSchema>

const tokenize = (s: string): ReadonlySet<string> => {
  const out = new Set<string>()
  const re = /[a-z0-9]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s.toLowerCase())) !== null) {
    if (m[0].length > 0) out.add(m[0])
  }
  return out
}

/**
 * Plan coverage: what fraction of the goal's tokens appear in
 * any plan step's description? Returns 0 for an empty goal or
 * empty plan.
 */
export const planCoverageScore = (
  goal: string,
  steps: ReadonlyArray<{ description: string }>,
): number => {
  const goalTokens = tokenize(goal)
  if (goalTokens.size === 0 || steps.length === 0) return 0
  const stepTokens = new Set<string>()
  for (const s of steps) for (const t of tokenize(s.description)) stepTokens.add(t)
  let hits = 0
  for (const t of goalTokens) if (stepTokens.has(t)) hits += 1
  return hits / goalTokens.size
}

/**
 * Reflection confidence: extract the most-recent `[confidence: 0.XX]`
 * suffix from a string. Falls back to a deterministic heuristic
 * (length-weighted) when no suffix is present.
 */
export const reflectionConfidenceScore = (text: string): number => {
  const match = /\[confidence:\s*(-?[0-9.]+)\]/.exec(text)
  if (match && match[1]) {
    const parsed = Number.parseFloat(match[1])
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed))
  }
  // Fallback: tokens / 200, clamped.
  return Math.max(0, Math.min(1, tokenize(text).size / 200))
}

/**
 * Sub-agent coordination: 1.0 if every result has a non-empty
 * `finalMessage.content`; decreases linearly for empty results.
 */
export const subagentCoordinationScore = (
  results: ReadonlyArray<{ finalMessage: { content?: string } }>,
): number => {
  if (results.length === 0) return 0
  let nonEmpty = 0
  for (const r of results) {
    if (r.finalMessage.content && r.finalMessage.content.length > 0) nonEmpty += 1
  }
  return nonEmpty / results.length
}

/**
 * Compute the three rule-based quality scores from raw inputs.
 * Validates the result through QualityScoresSchema.
 */
export const computeQualityScores = (input: {
  readonly goal?: string
  readonly planSteps?: ReadonlyArray<{ description: string }>
  readonly reflectionText?: string
  readonly subagentResults?: ReadonlyArray<{ finalMessage: { content?: string } }>
}): QualityScores => {
  const scores: QualityScores = {
    planCoverage:
      input.goal !== undefined && input.planSteps !== undefined
        ? planCoverageScore(input.goal, input.planSteps)
        : 0,
    reflectionConfidence:
      input.reflectionText !== undefined
        ? reflectionConfidenceScore(input.reflectionText)
        : 0,
    subagentCoordination:
      input.subagentResults !== undefined
        ? subagentCoordinationScore(input.subagentResults)
        : 0,
  }
  return QualityScoresSchema.parse(scores)
}

/**
 * Render quality scores as a markdown table row column. Stays
 * stable across scenarios so a regression detector can diff
 * REPORT.md across runs.
 */
export const qualityTableCell = (scores: QualityScores): string =>
  `${scores.planCoverage.toFixed(2)}/${scores.reflectionConfidence.toFixed(2)}/${scores.subagentCoordination.toFixed(2)}`
