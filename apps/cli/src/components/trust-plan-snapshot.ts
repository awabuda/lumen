/**
 * Phase B.3 / P34.3 — Trust / Plan snapshot formatters.
 *
 * Pure helpers used by the TUI's `/trust` and `/plan`
 * slash commands (apps/cli/src/components/Chat.tsx).
 * Both helpers are pure-data: they take a list of
 * records / plans and emit a one-line summary the
 * TUI can drop into the chat log.
 *
 * Why a separate file:
 *   - the helpers are exercised in isolation by
 *     `trust-plan-snapshot.test.ts` (no TUI mount, no
 *     SqliteStore) — keeps the test hermetic.
 *   - the `lumen doctor --product` G-P3 probe and
 *     future command-line operators can reuse the
 *     same formatter without dragging in Ink.
 */

import type { MemoryRecord } from '@lumen/core'
import type { Plan } from '@lumen/core'

/**
 * Aggregate stats for a single kind of memory record.
 * Pure-data; no I/O.
 */
export interface KindTrustStats {
  readonly kind: string
  readonly count: number
  readonly meanTrust: number
  readonly minTrust: number
  readonly maxTrust: number
}

const emptyStats = (kind: string): KindTrustStats => ({
  kind,
  count: 0,
  meanTrust: 0,
  minTrust: 1,
  maxTrust: 0,
})

/**
 * Group records by kind and compute per-kind trust
 * stats. Records with `trust` outside [0, 1] are
 * dropped (defensive — SqliteStore never writes
 * them but a hand-edited row might).
 */
export const aggregateTrustByKind = (
  records: ReadonlyArray<Pick<MemoryRecord, 'kind' | 'trust'>>,
): ReadonlyArray<KindTrustStats> => {
  const byKind = new Map<string, number[]>()
  for (const r of records) {
    if (!Number.isFinite(r.trust)) continue
    if (r.trust < 0 || r.trust > 1) continue
    const bucket = byKind.get(r.kind)
    if (bucket !== undefined) bucket.push(r.trust)
    else byKind.set(r.kind, [r.trust])
  }
  const out: KindTrustStats[] = []
  for (const [kind, values] of byKind) {
    let sum = 0
    let min = 1
    let max = 0
    for (const v of values) {
      sum += v
      if (v < min) min = v
      if (v > max) max = v
    }
    out.push({
      kind,
      count: values.length,
      meanTrust: values.length > 0 ? sum / values.length : 0,
      minTrust: min,
      maxTrust: max,
    })
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind))
  return out
}

/**
 * Format the trust snapshot for the TUI's
 * `/trust` slash. The output is a compact
 * Markdown-flavoured table that reads cleanly in
 * the Ink renderer without breaking lines.
 *
 *   [trust] total=42 kinds=3
 *     agent      count=12  mean=0.71  min=0.55  max=0.92
 *     reflection count=18  mean=0.50  min=0.30  max=0.85
 *     user       count=12  mean=0.85  min=0.70  max=1.00
 */
export const formatTrustSnapshot = (input: {
  readonly records: ReadonlyArray<Pick<MemoryRecord, 'kind' | 'trust'>>
}): string => {
  const stats = aggregateTrustByKind(input.records)
  if (stats.length === 0) {
    return '[trust] no records yet — run a multi-step agent loop to populate memory'
  }
  const total = stats.reduce((s, k) => s + k.count, 0)
  const lines: string[] = []
  lines.push(`[trust] total=${total} kinds=${stats.length}`)
  for (const k of stats) {
    lines.push(
      `  ${k.kind.padEnd(12)} count=${String(k.count).padEnd(4)} mean=${k.meanTrust.toFixed(2)} min=${k.minTrust.toFixed(2)} max=${k.maxTrust.toFixed(2)}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format a single plan as one bullet:
 *   <id>: <goal>  steps=<n>
 */
export const formatPlanLine = (plan: Plan): string => {
  return `  ${plan.id}: ${plan.goal}  steps=${plan.steps.length}`
}

/**
 * Format the plan snapshot for the TUI's
 * `/plan` slash. Reads the live `PlanStore` (process
 * memory) so the operator sees the plan the agent
 * is currently executing.
 *
 *   [plan] active=2 archived=1
 *     p-1: Write README.md  steps=3
 *     p-2: Add P34.3 tests  steps=2
 */
export const formatPlanSnapshot = (store: { readonly all: ReadonlyArray<Plan> }): string => {
  const all = store.all
  if (all.length === 0) {
    return '[plan] no plans yet — run an agent loop in `mode: auto` to see plans here'
  }
  const lines: string[] = []
  lines.push(`[plan] count=${all.length}`)
  for (const plan of all) {
    lines.push(formatPlanLine(plan))
  }
  return lines.join('\n')
}
