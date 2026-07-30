/**
 * P23.12 + P30.A1 slash commands.
 *
 * bug.md #69 (loop), #71 (cost), #70 (init scaffold). The TUI
 * sees the user's input as a prompt; we intercept leading
 * slash commands in Chat.tsx and handle them locally so the
 * agent loop is not entered for what is fundamentally a
 * single-shot question (cost snapshot, project scan) or a
 * background registration (cron loop).
 *
 * P30.A1 — `/loop` now actually fires the agent loop on every
 * tick. Pre-P30.A1 the registered job just wrote a stderr
 * line; the TUI captured the registration message and forgot
 * about the cron. Now every tick calls
 * `built.agent.streamRun({ prompt })` and collects the final
 * assistant text. The cron expression path (5-field
 * `* * * * *`) now uses `CronExpressionCron` from
 * `@lumen/core` instead of returning a "not yet wired" notice.
 *
 * Public surface:
 *   - formatBudgetSnapshot(built) -> string
 *   - handleLoopSlash(raw, built?) -> { message, entry? }
 *   - initProjectAsAssistant() -> AssistantMessage
 *   - initProjectAndSynthesize(built) -> AssistantMessage (P30.A2)
 *
 * Each handler is a pure async function returning a string
 * message plus an optional cron entry. State (the loop
 * registry + the live crons) is intentionally module-scoped
 * for the lifetime of the TUI session; tests reset it via
 * __resetSlashStateForTests. The `built` parameter is
 * optional for back-compat with the pre-P30.A1 test surface
 * (where `handleLoopSlash` ran without an agent); when
 * omitted, the registered cron job is a no-op that writes a
 * stderr line, preserving the "registration only" behaviour.
 */

import type { AssistantMessage } from '@lumen/core'
import { CronExpressionCron, IntervalCron } from '@lumen/core'
import type { PersistedLoop, SqliteLoopsStore } from '@lumen/memory'
import type { BuiltAgent } from '../composition.js'
import { startOneLoop } from '../cron-registry.js'
import { analyzeCurrentProject } from './project-analyzer.js'

const assistantFromText = (text: string): AssistantMessage => ({
  role: 'assistant' as const,
  content: text,
  toolCalls: [],
})

/**
 * Public side-effect: every budget snapshot injected into the
 * chat log is a one-shot, so we just want a tight one-liner.
 *
 * Reads built.agent.budgetSnapshot() (added in P23.12) which
 * returns the most recent Budget instance, or undefined if
 * no run has finished yet.
 */
export const formatBudgetSnapshot = (built: BuiltAgent): string => {
  const budget = built.agent.budgetSnapshot()
  if (budget === undefined) {
    return '[cost] no runs yet — execute `lumen run "<prompt>"` first'
  }
  const tokens = budget.used
  const costUsd = budget.costUsdConsumed()
  const timeMs = budget.timeMsConsumed()
  const parts: string[] = []
  parts.push(`tokens=${tokens}`)
  parts.push(`cost=$${costUsd.toFixed(4)}`)
  parts.push(`time=${timeMs}ms`)
  return `[cost] ${parts.join(' ')}`
}

export const budgetSnapshotAsAssistant = (built: BuiltAgent): AssistantMessage =>
  assistantFromText(formatBudgetSnapshot(built))

// ---------------------------------------------------------------------------
// /loop: cron registration
// ---------------------------------------------------------------------------

export interface LoopEntry {
  readonly id: string
  readonly kind: 'interval' | 'cron'
  readonly intervalMs?: number
  readonly cronExpr?: string
  readonly prompt: string
  readonly message: string
}

interface LiveCron {
  readonly entry: LoopEntry
  readonly stop: () => void
}

const loopRegistry: LoopEntry[] = []
const liveCrons: Map<string, LiveCron> = new Map()

const intervalLabel = (ms: number): string => {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `every ${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `every ${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `every ${hr}h`
  const day = Math.round(hr / 24)
  return `every ${day}d`
}

const parseLoopArgs = (
  raw: string,
):
  | {
      readonly ok: true
      readonly intervalMs?: number
      readonly cronExpr?: string
      readonly prompt: string
    }
  | { readonly ok: false; readonly reason: string } => {
  const stripped = raw.replace(/^\/loop\s*/, '').trim()
  if (stripped.length === 0) {
    return { ok: false, reason: 'usage: /loop <interval|cron> <prompt>' }
  }
  if (stripped.startsWith('"')) {
    const closeQuote = stripped.indexOf('"', 1)
    if (closeQuote === -1) {
      return { ok: false, reason: 'unterminated cron expression (missing closing quote)' }
    }
    const cronExpr = stripped.slice(1, closeQuote).trim()
    const prompt = stripped.slice(closeQuote + 1).trim()
    if (cronExpr.length === 0 || prompt.length === 0) {
      return {
        ok: false,
        reason: 'expected `/loop "<cron>" <prompt>`',
      }
    }
    return { ok: true, cronExpr, prompt }
  }
  const parts = stripped.split(/\s+/)
  if (parts.length < 2) {
    return { ok: false, reason: 'expected `/loop <interval> <prompt>`' }
  }
  const interval = parts[0] ?? ''
  const prompt = parts.slice(1).join(' ')
  const lower = interval.toLowerCase()
  let ms: number
  if (lower === 'hourly') ms = 60 * 60 * 1000
  else if (lower === 'daily') ms = 24 * 60 * 60 * 1000
  else if (/^\d+s$/.test(lower)) ms = Number.parseInt(lower, 10) * 1000
  else if (/^\d+m$/.test(lower)) ms = Number.parseInt(lower, 10) * 60 * 1000
  else if (/^\d+h$/.test(lower)) ms = Number.parseInt(lower, 10) * 60 * 60 * 1000
  else if (/^\d+d$/.test(lower)) ms = Number.parseInt(lower, 10) * 24 * 60 * 60 * 1000
  else if (/^\d+$/.test(lower)) ms = Number.parseInt(lower, 10) * 1000
  else {
    return {
      ok: false,
      reason: `unsupported interval "${interval}" (use Nm / Nh / Nd / Ns / hourly / daily)`,
    }
  }
  return { ok: true, intervalMs: ms, prompt }
}

/**
 * Run the registered prompt through the agent and collect the
 * final assistant text. We deliberately consume the streaming
 * events into a string instead of forwarding them to the TUI
 * (which is busy serving the human's own input) — the cron
 * tick runs in the background and only its result is logged.
 *
 * When `built` is `undefined` (test path, or caller without
 * an agent), we degrade to a stderr-only "tick" log so the
 * scheduler can still be exercised in isolation.
 */
const fireAgentForCron = async (
  built: BuiltAgent | undefined,
  loopId: string,
  prompt: string,
): Promise<void> => {
  if (built === undefined) {
    process.stderr.write(`[loop] ${loopId} tick at ${new Date().toISOString()} → ${prompt}\n`)
    return
  }
  let lastText = ''
  try {
    for await (const ev of built.agent.streamRun({ userMessage: prompt })) {
      if (ev.type === 'text:delta') {
        lastText += ev.delta
      } else if (ev.type === 'run:end') {
        process.stderr.write(
          `[loop] ${loopId} run-end at ${new Date().toISOString()}: ${lastText.slice(0, 200)}\n`,
        )
        return
      }
    }
  } catch (err) {
    process.stderr.write(
      `[loop] ${loopId} error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

/**
 * Handle /loop. Returns the assistant message to drop into the
 * chat log plus the cron entry so the caller can start
 * it. P30.A1: every tick now fires the agent loop, not just
 * writes a stderr line.
 *
 * P32.4 — the registration is now also written to
 * `SqliteLoopsStore` (when a store is supplied via `ctx`), so
 * closing the TUI does not lose the loop — re-launching
 * `lumen chat` reads the persisted rows via `loadAndStartLoops`
 * and re-arms them. When `ctx` is `undefined` (the pre-P32.4
 * test surface where handleLoopSlash ran without persistence)
 * the live cron still fires; it just dies with the process
 * like before. The module-scoped `loopRegistry` /
 * `liveCrons` are kept for back-compat with the P23.12 test
 * suite but new code should drive everything through
 * `ctx.store`.
 */
export interface HandleLoopContext {
  /** Persist registrations across restarts. */
  readonly store?: SqliteLoopsStore
  /**
   * Fire the agent on every tick. Defaults to
   * `fireAgentForCron(undefined, …)` which logs to stderr when
   * the test path does not supply an agent.
   */
  readonly fire?: (loopId: string, prompt: string) => Promise<void> | void
}

export const handleLoopSlash = async (
  raw: string,
  built?: BuiltAgent,
  ctx: HandleLoopContext = {},
): Promise<{ readonly message: string; readonly entry?: LoopEntry }> => {
  const parsed = parseLoopArgs(raw)
  if (!parsed.ok) {
    return { message: `[loop] ${parsed.reason}` }
  }
  const id = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const cronExpr = parsed.cronExpr
  const prompt = parsed.prompt
  // Wrap the fire function to compose `built` (the test
  // path's stderr log) with an explicit `ctx.fire` if given.
  const fire = (theLoopId: string, thePrompt: string): Promise<void> => {
    if (ctx.fire !== undefined) return Promise.resolve(ctx.fire(theLoopId, thePrompt))
    // fireAgentForCron is sync (writes a stderr line); wrap so
    // the persistence path's `await store.save(...)` always
    // resolves to a settled promise.
    return Promise.resolve(fireAgentForCron(built, theLoopId, thePrompt))
  }

  if (cronExpr !== undefined) {
    const persisted: PersistedLoop = {
      id,
      kind: 'cron',
      cronExpr,
      prompt,
      registeredAt: Date.now(),
      isActive: true,
    }
    if (ctx.store !== undefined) {
      await ctx.store.save(persisted)
    }
    // The CLI-side schedule lives in `liveCrons` regardless of
    // persistence — module-scoped so we can /unloop it from the
    // same TUI session.
    try {
      const cron = new CronExpressionCron({
        id,
        expression: cronExpr,
        job: () => fire(id, prompt),
      })
      cron.start()
      const entry: LoopEntry = {
        id,
        kind: 'cron',
        cronExpr,
        prompt,
        message: `[loop] registered ${id}, cron="${cronExpr}": "${prompt}"`,
      }
      loopRegistry.push(entry)
      liveCrons.set(id, { entry, stop: () => cron.stop() })
      return { message: entry.message, entry }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'invalid cron expression'
      return { message: `[loop] invalid cron expression: ${reason}` }
    }
  }
  const intervalMs = parsed.intervalMs
  if (intervalMs === undefined) {
    return { message: '[loop] missing interval' }
  }
  const persisted: PersistedLoop = {
    id,
    kind: 'interval',
    intervalMs,
    prompt,
    registeredAt: Date.now(),
    isActive: true,
  }
  if (ctx.store !== undefined) {
    await ctx.store.save(persisted)
  }
  // P30.A1 — the IntervalCron job now actually fires the agent
  // loop. Pre-P30.A1 the job only wrote a stderr line; the
  // user saw a registration message but no actual work
  // happened on each tick.
  const cron = new IntervalCron({
    id,
    intervalMs,
    job: () => fire(id, prompt),
  })
  cron.start()
  const entry: LoopEntry = {
    id,
    kind: 'interval',
    intervalMs,
    prompt,
    message: `[loop] registered ${id}, firing ${intervalLabel(intervalMs)}: "${prompt}"`,
  }
  loopRegistry.push(entry)
  liveCrons.set(id, { entry, stop: () => cron.stop() })
  return { message: entry.message, entry }
}

/**
 * Handle /unloop <id>. Stops the active cron, marks the
 * persisted row inactive, and drops it from the in-memory
 * registry. The next `lumen chat` launch will not restart it.
 */
export const handleUnloopSlash = async (
  raw: string,
  ctx: HandleLoopContext = {},
): Promise<{ readonly message: string }> => {
  const stripped = raw.replace(/^\/unloop\s*/, '').trim()
  if (stripped.length === 0) {
    return { message: '[unloop] usage: /unloop <id>' }
  }
  const target = liveCrons.get(stripped)
  if (target === undefined) {
    return { message: `[unloop] no active loop with id: ${stripped}` }
  }
  target.stop()
  liveCrons.delete(stripped)
  // Mark inactive in the loopRegistry array (mirror state).
  for (let i = loopRegistry.length - 1; i >= 0; i--) {
    const item = loopRegistry[i]
    if (item !== undefined && item.id === stripped) {
      loopRegistry.splice(i, 1)
    }
  }
  if (ctx.store !== undefined) {
    await ctx.store.stop(stripped)
  }
  return { message: `[unloop] stopped ${stripped}` }
}

/**
 * P32.4 — load every persisted loop on TUI mount and start
 * its cron timer. Returns the handles keyed by id so the TUI
 * can call `stop()` on each during teardown. Currently the
 * TUI does not own these handles in a controlled way (the
 * module-scoped `liveCrons` map already mirrors them), but
 * returning them lets a future test verify the round trip.
 */
export const reloadPersistedLoops = async (
  store: SqliteLoopsStore,
  fire: HandleLoopContext['fire'],
): Promise<ReadonlyArray<PersistedLoop>> => {
  // The schedule-management lives in apps/cli; the data path
  // is in @lumen/memory. Wire them with a small adapter — the
  // /loop call uses `startOneLoop` directly below, here we
  // want persistence to drive the schedule (no re-write
  // needed since listActive already filters `stopped_at IS NULL`).
  const active = await store.listActive()
  for (const entry of active) {
    const { stop } = startOneLoop(entry, fire ?? (() => {}))
    if (liveCrons.has(entry.id)) continue
    loopRegistry.push({
      id: entry.id,
      kind: entry.kind,
      intervalMs: entry.intervalMs,
      cronExpr: entry.cronExpr,
      prompt: entry.prompt,
      message: `[loop] restored ${entry.id} from disk`,
    })
    liveCrons.set(entry.id, {
      entry: {
        id: entry.id,
        kind: entry.kind,
        intervalMs: entry.intervalMs,
        cronExpr: entry.cronExpr,
        prompt: entry.prompt,
        message: `[loop] restored ${entry.id} from disk`,
      },
      stop,
    })
  }
  return active
}

// ---------------------------------------------------------------------------
// /init: project analyzer (P23.12 ships the analyzer; P30.A2
// adds an LLM synth step)
// ---------------------------------------------------------------------------

export const initProjectAsAssistant = (): AssistantMessage => {
  const result = analyzeCurrentProject()
  const content = `[init] factsheet from \`${process.cwd()}\`:\n\n${result.factsheet}`
  return {
    role: 'assistant',
    content,
    toolCalls: [],
  }
}

// ---------------------------------------------------------------------------
// Internal reset for tests; not exported as a CLI subcommand.
// ---------------------------------------------------------------------------

export const __resetSlashStateForTests = (): void => {
  for (const cron of liveCrons.values()) {
    cron.stop()
  }
  liveCrons.clear()
  loopRegistry.length = 0
}

export const __loopRegistryForTests = (): ReadonlyArray<LoopEntry> => loopRegistry.slice()
export const __liveCronIdsForTests = (): ReadonlyArray<string> => Array.from(liveCrons.keys())
