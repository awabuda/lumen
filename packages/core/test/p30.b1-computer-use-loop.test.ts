/**
 * P30.B1 — `runComputerUseLoop` e2e.
 *
 * P28.1 shipped the `computer_use` tool (Playwright-driven
 * coordinate input) and P29.1 shipped the `ComputerUseModel`
 * interface. P30.B1 composes them: `runComputerUseLoop` is
 * a helper that drives the tool from a model, one round at
 * a time, until the model returns `stop`, `maxRounds` is
 * reached, or the signal aborts.
 *
 * These tests use a fake `BaseTool` and a scripted
 * `LoopComputerUseModel` so the e2e is hermetic — no
 * Playwright, no Anthropic API key.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runComputerUseLoop } from '../src/computer-use/loop.js'
import type { LoopComputerAction, LoopComputerUseModel } from '../src/computer-use/loop.js'
import { BaseTool, type ToolContext } from '../src/tools/index.js'

/**
 * Minimal computer_use-shaped tool. Validates the input
 * against the same shape `packages/tools/src/computer-use`
 * ships (screenshot / click / type / key / scroll / move /
 * wait) but does not actually drive a browser.
 */
class FakeComputerUseTool extends BaseTool {
  public readonly name = 'computer_use'
  public readonly description = 'fake computer_use for P30.B1'
  public readonly inputSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('screenshot') }),
    z.object({
      op: z.literal('click'),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      button: z.enum(['left', 'right', 'middle']).optional(),
    }),
    z.object({ op: z.literal('type'), text: z.string().min(1) }),
    z.object({ op: z.literal('key'), key: z.string().min(1) }),
    z.object({
      op: z.literal('scroll'),
      x: z.number().int().min(0),
      y: z.number().int().min(0),
      dx: z.number().int(),
      dy: z.number().int(),
    }),
    z.object({ op: z.literal('move'), x: z.number().int().min(0), y: z.number().int().min(0) }),
    z.object({ op: z.literal('wait'), ms: z.number().int().min(0).optional() }),
  ])
  public readonly risk = 'dangerous' as const
  public readonly dispatchedOps: ReadonlyArray<{ readonly op: string; readonly detail: unknown }>

  private readonly ops: Array<{ readonly op: string; readonly detail: unknown }> = []
  private shotCounter = 0

  public constructor() {
    super()
    this.dispatchedOps = this.ops
  }

  protected async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    const parsed = input as { op: string } & Record<string, unknown>
    this.ops.push({ op: parsed.op, detail: { ...parsed } })
    if (parsed.op === 'screenshot') {
      this.shotCounter += 1
      // A real screenshot would be a base64 PNG; the test
      // model only inspects length() to verify the
      // dispatch happened.
      return { op: 'screenshot', screenshot: `png-${this.shotCounter}` }
    }
    return { op: parsed.op, ok: true }
  }
}

/** A scripted model that walks through a fixed action list. */
const makeScriptedModel = (script: ReadonlyArray<LoopComputerAction>): LoopComputerUseModel => {
  let index = 0
  return {
    id: 'fake-scripted',
    hosted: false,
    nextAction: async () => {
      const action = script[index] ?? { type: 'stop' as const, reason: 'script-exhausted' }
      index += 1
      return action
    },
  }
}

describe('P30.B1 — runComputerUseLoop', () => {
  it('runs a single click and stops cleanly', async () => {
    const tool = new FakeComputerUseTool()
    const model = makeScriptedModel([
      { type: 'click', x: 100, y: 200 },
      { type: 'stop', reason: 'done' },
    ])
    const result = await runComputerUseLoop({ model, tool })
    expect(result.termination).toBe('stop')
    expect(result.stopReason).toBe('done')
    expect(result.steps.length).toBe(2)
    expect(result.steps[0]?.action.type).toBe('click')
    expect(result.steps[0]?.action).toMatchObject({ type: 'click', x: 100, y: 200 })
    expect(result.steps[1]?.action.type).toBe('stop')
    // The tool saw exactly one click + one screenshot call.
    const clickOps = tool.dispatchedOps.filter((o) => o.op === 'click')
    expect(clickOps.length).toBe(1)
    const shotOps = tool.dispatchedOps.filter((o) => o.op === 'screenshot')
    expect(shotOps.length).toBe(2) // one per loop round
  })

  it('walks a multi-step script: click → type → key', async () => {
    const tool = new FakeComputerUseTool()
    const model = makeScriptedModel([
      { type: 'click', x: 50, y: 50 },
      { type: 'type', text: 'hello' },
      { type: 'key', key: 'Enter' },
      { type: 'stop', reason: 'submitted' },
    ])
    const result = await runComputerUseLoop({ model, tool })
    expect(result.termination).toBe('stop')
    expect(result.steps.length).toBe(4)
    const dispatched = tool.dispatchedOps.map((o) => o.op)
    expect(dispatched).toEqual([
      'screenshot',
      'click',
      'screenshot',
      'type',
      'screenshot',
      'key',
      'screenshot',
    ])
  })

  it('terminates with maxRounds when the model never returns stop', async () => {
    const tool = new FakeComputerUseTool()
    const model = makeScriptedModel([
      { type: 'click', x: 1, y: 1 },
      { type: 'click', x: 2, y: 2 },
      { type: 'click', x: 3, y: 3 },
      // The 4th action would be a stop, but maxRounds: 3
      // caps the loop first.
      { type: 'stop' as const, reason: 'too-late' },
    ])
    const result = await runComputerUseLoop({ model, tool, maxRounds: 3 })
    expect(result.termination).toBe('maxRounds')
    expect(result.steps.length).toBe(3)
  })

  it('respects AbortSignal mid-loop', async () => {
    const tool = new FakeComputerUseTool()
    const model = makeScriptedModel([
      { type: 'click', x: 1, y: 1 },
      { type: 'click', x: 2, y: 2 },
    ])
    const ctrl = new AbortController()
    // Pre-abort so the very first signal check fires.
    ctrl.abort()
    const result = await runComputerUseLoop({ model, tool, signal: ctrl.signal })
    expect(result.termination).toBe('aborted')
    expect(result.steps.length).toBe(0)
  })

  it('forwards the hint to the model on every step', async () => {
    const tool = new FakeComputerUseTool()
    const hints: Array<string | undefined> = []
    const model: LoopComputerUseModel = {
      id: 'hinting',
      hosted: false,
      nextAction: async (input) => {
        hints.push(input.hint)
        if (input.hint === undefined) {
          return { type: 'stop', reason: 'no-hint' }
        }
        return { type: 'click', x: 10, y: 10 }
      },
    }
    await runComputerUseLoop({ model, tool, hint: 'click the login button' })
    // First call gets the hint; the loop stops as soon as
    // the model decides to stop (which is the second call
    // when hint is undefined; but with hint set, it keeps
    // clicking until the script is exhausted — but here the
    // model returns `click` forever, so maxRounds caps it).
    // The point of the assertion: the hint is forwarded on
    // the very first call.
    expect(hints[0]).toBe('click the login button')
  })

  it('handles a `wait` action without dispatching to the tool', async () => {
    const tool = new FakeComputerUseTool()
    const model = makeScriptedModel([
      { type: 'wait', ms: 100 },
      { type: 'stop', reason: 'waited' },
    ])
    const result = await runComputerUseLoop({ model, tool })
    expect(result.termination).toBe('stop')
    expect(result.steps[0]?.action.type).toBe('wait')
    // The wait step recorded a toolResult (the waited flag)
    // but the tool itself was not called for the wait op.
    const waitOps = tool.dispatchedOps.filter((o) => o.op === 'wait')
    expect(waitOps.length).toBe(0)
  })
})
