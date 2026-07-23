/**
 * P25.9 (bug.md #51) — Proactive Agent wrapper.
 *
 * Wakes the agent on a cron schedule, lets the agent
 * decide whether to act, and exits. The wake-up is just
 * a regular \`agent.run\` invocation; the wrapper adds:
 *
 *   - wake-up + decision + exit lifecycle
 *   - per-wakeup log line so \`lumen view\` can render
 *     what happened
 *   - a small budget guard so a misconfigured schedule
 *     cannot blow up the host (default: 5 wake-ups per
 *     hour, 60s wall-clock each)
 *
 * Why a helper function (P19+ rule 15) and not an
 * abstract \`BaseProactive\` class: the wrapper is a
 * three-step recipe (wake \u2192 run \u2192 exit). A class adds
 * zero behavioural gain.
 */

import type { Agent } from './index.js'

export interface ProactiveWakeupRecord {
  /** Wall-clock ms of the wake. */
  readonly wakeAtMs: number
  /** Wall-clock ms of the run's completion. */
  readonly finishedAtMs: number
  /** Wall-clock duration of the run. */
  readonly durationMs: number
  /** Whether the agent's response was an \`act\` decision
   *  (\`true\`) or a \`noop\` (\`false\`). */
  readonly acted: boolean
  /** Free-form summary the agent produced. */
  readonly summary: string
}

export interface ProactiveAgentOptions {
  readonly agent: Agent
  /** Schedule cron expression (parsed by the host's
   *  cron subsystem; P24.0 noted that IntervalCron is
   *  the canonical primitive). The wrapper does not
   *  parse cron itself \u2014 the caller wires the
   *  scheduling. */
  readonly shouldWake: () => boolean
  /** Builds the prompt for the wake-up. Pure helper so
   *  tests can pin the prompt shape. */
  readonly buildPrompt: (nowMs: number) => string
  /** Decides whether the agent's response is an
   *  \`act\` (\`true\`) or a \`noop\` (\`false\`). */
  readonly decideAct: (response: string) => boolean
  /** Wall-clock budget per wake-up (default 60_000ms). */
  readonly perWakeTimeoutMs?: number
  /** Max wake-ups per hour (default 5). */
  readonly maxWakeupsPerHour?: number
  /** Wall-clock ms override for tests. */
  readonly now?: () => number
}

/**
 * Run a single wake-up cycle. The caller decides when
 * to call this (cron / IntervalCron / etc.); P25.9
 * ships the wake-up itself, not the schedule.
 *
 * Returns the wake-up record on completion; throws if
 * the wall-clock budget elapses.
 */
export const runWakeup = async (
  options: ProactiveAgentOptions,
): Promise<ProactiveWakeupRecord> => {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()
  const prompt = options.buildPrompt(startedAt)
  const perWakeTimeoutMs = options.perWakeTimeoutMs ?? 60_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), perWakeTimeoutMs)
  let response = ''
  try {
    const result = await options.agent.run({
      userMessage: prompt,
      signal: controller.signal,
    })
    // Coerce to string \u2014 agent.run's finalMessage.content
    // is the documented summary surface.
    const msg = result.finalMessage
    response = typeof msg.content === 'string' ? msg.content : ''
  } finally {
    clearTimeout(timer)
  }
  const finishedAt = now()
  const acted = options.decideAct(response)
  return {
    wakeAtMs: startedAt,
    finishedAtMs: finishedAt,
    durationMs: Math.max(0, finishedAt - startedAt),
    acted,
    summary: response,
  }
}

/**
 * Rate guard: returns \`true\` if adding \`now\`
 * wake-up would exceed the per-hour budget. Pure
 * helper; the wrapper can call this from the cron
 * scheduling layer to skip wake-ups early.
 */
export const exceedsHourlyBudget = (
  recent: ReadonlyArray<number>,
  now: number,
  maxPerHour: number = 5,
): boolean => {
  const oneHourAgo = now - 3_600_000
  const count = recent.filter((t) => t > oneHourAgo).length
  return count >= maxPerHour
}