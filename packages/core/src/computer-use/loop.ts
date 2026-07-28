/**
 * P30.B1 — `runComputerUseLoop` (P29.3 wire-up).
 *
 * P28.1 shipped the `computer_use` tool (Playwright-driven
 * coordinate input) and P29.1 shipped the `ComputerUseModel`
 * interface (screenshot-in / action-out). P30.B1 closes
 * the P29.3 commitment: a standalone helper that composes
 * the two into a "screenshot → model.nextAction → tool
 * dispatch → repeat" loop.
 *
 * Why a helper function and not a new middleware (P19+
 * rule 11): this is not an extension of the Agent loop —
 * it's a self-contained orchestration. The `computer_use`
 * tool is the entire tool surface; the model is the only
 * decision maker. Pulling it into the Agent.run middleware
 * chain would force every Agent.run to opt out, which is
 * the wrong default.
 *
 * Why a helper function and not an abstract class (P19+
 * rule 14): the surface is small (`model` + `tool` +
 * `maxRounds`) and the only sensible implementation
 * matches the loop described in this file. An abstract
 * base would be one-class-one-implementation noise.
 *
 * Why core does NOT import @lumen/llm: tier isolation.
 * The `ComputerUseModel` interface in @lumen/llm is
 * duck-typed here; any implementation that satisfies the
 * structural contract works. The Anthropic reference
 * impl from @lumen/llm plugs in unchanged.
 *
 * Termination conditions:
 *   1. The model returns a `stop` action.
 *   2. The loop hits `maxRounds` (default 25).
 *   3. The signal aborts.
 *
 * The function returns the full step history so the caller
 * can audit the run.
 */

import { z } from 'zod'

import type { BaseTool, ToolContext } from '../tools/index.js'

/**
 * The Computer-Use model contract. Duck-typed against
 * `@lumen/llm`'s `ComputerUseModel`; we do not import
 * the @lumen/llm type to keep the tier-isolation rule
 * (core does not depend on @lumen/llm).
 */
export interface LoopComputerUseModel {
  readonly id: string
  readonly hosted: boolean
  nextAction(input: {
    readonly screenshot: string
    readonly history: ReadonlyArray<{
      readonly action: LoopComputerAction
      readonly note?: string
    }>
    readonly hint?: string
  }): Promise<LoopComputerAction>
}

/** A single Computer-Use action. Mirrors the @lumen/llm
 *  `ComputerAction` discriminated union. */
export type LoopComputerAction =
  | {
      readonly type: 'click'
      readonly x: number
      readonly y: number
      readonly button?: 'left' | 'right' | 'middle'
    }
  | { readonly type: 'type'; readonly text: string }
  | { readonly type: 'key'; readonly key: string }
  | {
      readonly type: 'scroll'
      readonly x: number
      readonly y: number
      readonly dx: number
      readonly dy: number
    }
  | { readonly type: 'wait'; readonly ms?: number }
  | { readonly type: 'stop'; readonly reason?: string }

/** Zod schema for a single step's persisted record. */
export const ComputerUseStepSchema = z.object({
  /** 1-based step index. */
  index: z.number().int().min(1),
  /** Action the model returned for this step. */
  action: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('click'),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      button: z.enum(['left', 'right', 'middle']).optional(),
    }),
    z.object({ type: z.literal('type'), text: z.string().min(1) }),
    z.object({ type: z.literal('key'), key: z.string().min(1) }),
    z.object({
      type: z.literal('scroll'),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      dx: z.number().int(),
      dy: z.number().int(),
    }),
    z.object({ type: z.literal('wait'), ms: z.number().int().min(0).optional() }),
    z.object({ type: z.literal('stop'), reason: z.string().optional() }),
  ]),
  /** Tool result for this step (if the action was a tool
   *  call; the model got it on the next round). */
  toolResult: z.unknown().optional(),
  /** Wall-clock duration of this step. */
  durationMs: z.number().int().min(0),
})
export type ComputerUseStep = z.infer<typeof ComputerUseStepSchema>

/** Final return value of `runComputerUseLoop`. */
export interface ComputerUseLoopResult {
  /** The persisted step history, in order. */
  readonly steps: ReadonlyArray<ComputerUseStep>
  /** Why the loop terminated. */
  readonly termination: 'stop' | 'maxRounds' | 'aborted' | 'error'
  /** The model's `stop` reason, if it stopped cleanly. */
  readonly stopReason?: string
  /** Aggregate wall-clock duration. */
  readonly durationMs: number
}

export const RunComputerUseLoopOptionsSchema = z
  .object({
    /** The Computer-Use model. Required. */
    model: z.custom<LoopComputerUseModel>(
      (v) => typeof v === 'object' && v !== null && 'nextAction' in v,
    ),
    /** The computer_use tool (or any tool whose `call({op: ...})`
     *  surface matches the LoopComputerAction vocabulary).
     *  Required. */
    tool: z.custom<BaseTool>((v) => typeof v === 'object' && v !== null && 'call' in v),
    /** Optional free-form hint from the operator (e.g.
     *  "log in to the dashboard"). The model sees it
     *  on every step. */
    hint: z.string().optional(),
    /** Maximum number of screenshot→action rounds. Default 25. */
    maxRounds: z.number().int().min(1).max(1000).optional(),
    /** Abort signal. */
    signal: z.custom<AbortSignal>().optional(),
    /** ToolContext to pass to tool.call. The caller supplies
     *  cwd / sessionId / log / signal. */
    ctx: z.custom<Omit<ToolContext, 'signal'>>().optional(),
  })
  .strict()
export type RunComputerUseLoopOptions = z.input<typeof RunComputerUseLoopOptionsSchema>

/**
 * Run a Computer-Use loop. Each round:
 *   1. Call `tool.call({ op: 'screenshot' })` to get the
 *      current PNG.
 *   2. Pass the screenshot + history + hint to
 *      `model.nextAction()`.
 *   3. Dispatch the action back through `tool.call`.
 *   4. Append a `ComputerUseStep` to the history.
 * Stop when the model returns `stop`, when `maxRounds` is
 * reached, or when the signal aborts.
 */
export const runComputerUseLoop = async (
  rawOptions: RunComputerUseLoopOptions,
): Promise<ComputerUseLoopResult> => {
  const options = RunComputerUseLoopOptionsSchema.parse(rawOptions)
  const { model, tool } = options
  const hint = options.hint
  const maxRounds = options.maxRounds ?? 25
  const signal = options.signal
  const ctxBase: Omit<ToolContext, 'signal'> = options.ctx ?? {
    cwd: process.cwd(),
    sessionId: 'computer-use',
    log: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const innerSignal = signal ?? new AbortController().signal
  const ctx: ToolContext = { ...ctxBase, signal: innerSignal }

  const steps: ComputerUseStep[] = []
  const history: Array<{ action: LoopComputerAction; note?: string }> = []
  const t0 = Date.now()
  let termination: ComputerUseLoopResult['termination'] = 'maxRounds'
  let stopReason: string | undefined

  for (let i = 1; i <= maxRounds; i += 1) {
    if (innerSignal.aborted) {
      termination = 'aborted'
      break
    }
    const stepStart = Date.now()
    // 1. Screenshot
    const shotUnknown = await tool.call({ op: 'screenshot' }, ctx)
    const shot = shotUnknown as { screenshot?: string }
    if (typeof shot.screenshot !== 'string' || shot.screenshot.length === 0) {
      termination = 'error'
      break
    }
    // 2. Ask the model for the next action
    const action = await model.nextAction({
      screenshot: shot.screenshot,
      history,
      ...(hint !== undefined ? { hint } : {}),
    })
    // 3. Dispatch the action (unless it's `stop` or `wait`)
    let toolResult: unknown = undefined
    if (
      action.type === 'click' ||
      action.type === 'type' ||
      action.type === 'key' ||
      action.type === 'scroll'
    ) {
      // Wrap the action in the { op, ... } shape the tool
      // expects (the LoopComputerAction vocabulary does not
      // carry the `op` discriminator; the tool does).
      toolResult = await tool.call({ op: action.type, ...action }, ctx)
    }
    if (action.type === 'wait') {
      // Tool-side wait is a no-op dispatch; the agent loop's
      // own sleep is via the model's next round. We just
      // record the wait as a step.
      toolResult = { waited: true, ms: action.ms ?? 0 }
    }
    // 4. Append the step
    const step: ComputerUseStep = {
      index: i,
      action,
      ...(toolResult !== undefined ? { toolResult } : {}),
      durationMs: Date.now() - stepStart,
    }
    steps.push(step)
    history.push({ action })
    // 5. Termination check
    if (action.type === 'stop') {
      termination = 'stop'
      stopReason = action.reason
      break
    }
  }

  return {
    steps,
    termination,
    ...(stopReason !== undefined ? { stopReason } : {}),
    durationMs: Date.now() - t0,
  }
}
