/**
 * P32.4 — Cron-registry CLI wrapper.
 *
 * Two responsibilities on top of `@lumen/memory` `SqliteLoopsStore`:
 *
 *   1. `loadAndStartLoops(store, fire)` — on `lumen chat` mount,
 *      re-issue every persisted loop that does NOT have
 *      `stopped_at` set, returning a list of stop handles the TUI
 *      keeps until unmount.
 *
 *   2. `startOneLoop(entry, fire)` — start the matching
 *      `IntervalCron` or `CronExpressionCron` from `@lumen/core`
 *      based on the entry's `kind`, return its stop handle.
 *
 * The split is deliberate: storage lives in `@lumen/memory` next
 * to other SQLite-backed stores (so it shares the
 * `mkdirSync`-on-construct invariant from P32.1.1), while the
 * schedule-management helpers stay in `apps/cli` because they
 * sit right next to the slash-command wiring and need no
 * embedding elsewhere.
 *
 * Why helper functions, not a class:
 *   CLAUDE rule #15 (`helper > abstract class`). The two
 *   operations here do not share hidden state — `startOneLoop`
 *   produces a stop handle that the caller manages — so a class
 *   wrapper would just be wrapping a Map of cron handles for no
 *   benefit. The slash-commands layer already owns the lifetime
 *   bookkeeping (`liveCrons`), so the registry only needs to
 *   hand back the stop closures.
 */

import { CronExpressionCron, IntervalCron } from '@lumen/core'
import type { PersistedLoop, SqliteLoopsStore } from '@lumen/memory'

/**
 * Start one persisted loop and return its stop handle. The
 * caller owns the returned `stop` and must invoke it on TUI
 * unmount to release the underlying timer.
 *
 * The `fire` callback wraps `built.agent.streamRun` in
 * `slash-commands.ts`; this module accepts it as an opaque
 * async function so the storage layer can stay
 * `@lumen/memory`-only.
 */
export const startOneLoop = (
  entry: PersistedLoop,
  fire: (loopId: string, prompt: string) => Promise<void> | void,
): { stop: () => void } => {
  // `CronJob` is `() => Promise<void>` (P23 core schema), but our
  // `fire` adapter is the wider `Promise<void> | void` so a caller
  // that supplies a sync stub still type-checks. Wrap in async
  // here so the cron schedulers see the canonical signature.
  const job = async (): Promise<void> => {
    await fire(entry.id, entry.prompt)
  }
  if (entry.kind === 'interval' && entry.intervalMs !== undefined) {
    const cron = new IntervalCron({
      id: entry.id,
      intervalMs: entry.intervalMs,
      job,
    })
    cron.start()
    return { stop: () => cron.stop() }
  }
  if (entry.kind === 'cron' && entry.cronExpr !== undefined) {
    const cron = new CronExpressionCron({
      id: entry.id,
      expression: entry.cronExpr,
      job,
    })
    cron.start()
    return { stop: () => cron.stop() }
  }
  // Defensive: a malformed row that survived the upsert path is
  // a row tampering case or a future schema drift. Skip it
  // silently rather than throw — the CLI's `/loop` reload
  // would rather lose one bad row than refuse to boot.
  return { stop: () => {} }
}

/**
 * Iterate every active persisted loop and start it. Return
 * the handles keyed by loop id so the caller can stop them
 * all on unmount.
 */
export const loadAndStartLoops = async (
  store: SqliteLoopsStore,
  fire: (loopId: string, prompt: string) => Promise<void> | void,
): Promise<Map<string, { stop: () => void }>> => {
  const active = await store.listActive()
  const handles = new Map<string, { stop: () => void }>()
  for (const entry of active) {
    handles.set(entry.id, startOneLoop(entry, fire))
  }
  return handles
}
