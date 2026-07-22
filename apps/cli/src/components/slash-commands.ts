/**
 * P23.12 slash commands.
 *
 * bug.md #69 (loop), #71 (cost), #70 (init scaffold). The TUI
 * sees the user's input as a prompt; we intercept leading
 * slash commands in Chat.tsx and handle them locally so the
 * agent loop is not entered for what is fundamentally a
 * single-shot question (cost snapshot, project scan) or a
 * background registration (cron loop).
 *
 * Public surface:
 *   - formatBudgetSnapshot(built) -> string
 *   - handleLoopSlash(raw) -> { message, entry? }
 *   - initProjectAsAssistant() -> AssistantMessage
 *
 * Each handler is a pure async function returning a string
 * message plus an optional cron entry. State (the loop
 * registry) is intentionally module-scoped for the lifetime
 * of the TUI session; tests reset it via
 * __resetSlashStateForTests.
 */

import type { AssistantMessage } from '@lumen/core'
import { IntervalCron } from '@lumen/core'
import type { BuiltAgent } from '../composition.js'
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
  readonly kind: 'interval' | 'once'
  readonly intervalMs?: number
  readonly at?: number
  readonly cronExpr?: string
  readonly prompt: string
  readonly message: string
}

const loopRegistry: LoopEntry[] = []

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
 * Handle /loop. Returns the assistant message to drop into
 * the chat log plus the cron entry so the caller can start
 * it.
 */
export const handleLoopSlash = async (
  raw: string,
): Promise<{ readonly message: string; readonly entry?: LoopEntry }> => {
  const parsed = parseLoopArgs(raw)
  if (!parsed.ok) {
    return { message: `[loop] ${parsed.reason}` }
  }
  const id = `loop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const cronExpr = parsed.cronExpr
  const prompt = parsed.prompt
  if (cronExpr !== undefined) {
    // OnceCron at next-minute-boundary is the closest we have
    // to a real cron expression evaluation without pulling in
    // cron-parser. P23.12 ships the surface; full cron expr
    // parsing is a downstream concern for the IntervalCron
    // library — emit a clear message rather than failing
    // silently.
    return {
      message: `[loop] cron expressions (${cronExpr}) are not yet wired in IntervalCron — switch the IntervalCron library first (P24 follow-up)`,
    }
  }
  const intervalMs = parsed.intervalMs
  if (intervalMs === undefined) {
    return { message: '[loop] missing interval' }
  }
  const entry: LoopEntry = {
    id,
    kind: 'interval',
    intervalMs,
    prompt,
    message: `[loop] registered ${id}, firing ${intervalLabel(intervalMs)}: "${prompt}"`,
  }
  loopRegistry.push(entry)
  // Start the cron. The IntervalCron stores its history but
  // does not fire the LLM — for the operator-facing scaffold,
  // the registered job logs the next-fire timestamp on every
  // tick. P24 follow-up hooks the registered prompt into
  // agent.streamRun so the loop actually fires an agent run.
  const cron = new IntervalCron({
    id,
    intervalMs,
    job: async () => {
      process.stderr.write(`[loop] ${id} tick at ${new Date().toISOString()} → ${prompt}\n`)
    },
  })
  cron.start()
  return { message: entry.message, entry }
}

// ---------------------------------------------------------------------------
// /init: project analyzer (P23.12 ships the real analyzer)
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
  loopRegistry.length = 0
}

export const __loopRegistryForTests = (): ReadonlyArray<LoopEntry> => loopRegistry.slice()
