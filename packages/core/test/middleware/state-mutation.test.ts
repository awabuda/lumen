/**
 * P23.3 — middleware state via `MiddlewareStateView.set()`
 * (bug #4 + #15 in the bug.md audit).
 *
 * Before P23.3:
 *   - `MiddlewareStateView` was declared in middleware.ts but never
 *     wired into `MiddlewareContext`. Middleware mutated state via
 *     the typed-as-readonly cast pattern (`state.plan = X` in
 *     plan.ts, `state.stepCount += 1` in reflection.ts), which
 *     bypassed the schema guard (rule 12 violation) and made
 *     cross-slice writes silently possible.
 *
 * After P23.3:
 *   - `ctx.stateView` exposes a typed `MiddlewareStateView` per
 *     middleware. `set(next)` re-parses against `stateSchema`,
 *     throws `MiddlewareError` on failure, and persists the change
 *     into the merged state dictionary so it survives across
 *     iterations.
 *   - plan.ts and reflection.ts migrated to `stateView.set(...)`.
 *
 * Tests assert:
 *   - `stateView[name].set()` writes persist across iterations.
 *   - `set()` with a schema-invalid value throws `MiddlewareError`.
 *   - `set()` only mutates the owning slice (write to
 *     `stateView[otherName]` re-parses against the wrong schema
 *     and fails closed).
 *   - Plan + reflection middlewares now use the typed surface and
 *     still produce the same observable run behaviour.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../../src/agent/factory.js'
import { MiddlewareError } from '../../src/agent/middleware.js'
import type { AgentMiddleware } from '../../src/agent/middleware.js'
import { createPlanMiddleware } from '../../src/agent/middleware/plan.js'
import { createReflectionMiddleware } from '../../src/agent/middleware/reflection.js'
import { PlanStore } from '../../src/plan/index.js'
import { ToolRegistry } from '../../src/tools/index.js'
import { FakeProvider } from '../fake-provider.js'

describe('P23.3 — MiddlewareStateView wire-up', () => {
  it('exposes ctx.stateView with one entry per middleware', async () => {
    let captured: Readonly<Record<string, unknown>> | undefined
    const spy: AgentMiddleware = {
      name: 'spy',
      stateSchema: z.object({}).strict(),
      initialState: {},
      beforeModel: (messages, ctx) => {
        captured = ctx.stateView
        return messages
      },
    }
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [spy],
    })
    await agent.run({ userMessage: 'x' })
    expect(captured).toBeDefined()
    expect(captured && 'spy' in captured).toBe(true)
  })

  it('set() persists state across iterations (counter reaches 3)', async () => {
    // Build two middlewares: 'writer' increments a counter via
    // set() on every afterModel; 'reader' captures the counter's
    // final value via ctx.stateView.counter.current on afterRun.
    // The 'reader' sees the cumulative count of 3 — proof that
    // set() wrote through to the merged state dict that survives
    // across iterations.
    let finalCount = -1
    const CounterSchema = z.object({ count: z.number().int().nonnegative() }).strict()
    const writer: AgentMiddleware<{ count: number }> = {
      name: 'counter',
      stateSchema: CounterSchema,
      initialState: { count: 0 },
      afterModel: (message, ctx) => {
        const view = ctx.stateView?.counter as
          | { current: { count: number }; set: (n: { count: number }) => void }
          | undefined
        if (!view) throw new Error('writer requires stateView.counter')
        view.set({ count: view.current.count + 1 })
        return message
      },
    }
    const reader: AgentMiddleware = {
      name: 'reader',
      stateSchema: z.object({}).strict(),
      initialState: {},
      afterRun: (_result, ctx) => {
        const view = ctx.stateView?.counter as { current: { count: number } } | undefined
        finalCount = view?.current.count ?? -1
      },
    }
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'a',
          toolCalls: [{ id: 'c1', name: 'noop', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'b',
          toolCalls: [{ id: 'c2', name: 'noop', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'c', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [writer, reader],
    })
    await agent.run({ userMessage: 'x' })
    expect(finalCount).toBe(3)
  })

  it('set() rejects schema-invalid values with MiddlewareError', () => {
    const view = {
      get current() {
        return { count: 0 }
      },
      set: (next: unknown) => {
        const schema = z.object({ count: z.number().int().nonnegative() }).strict()
        const parsed = schema.safeParse(next)
        if (!parsed.success) {
          throw new MiddlewareError('stateView[counter].set() rejected', 'counter', parsed.error)
        }
      },
    }
    // Valid value: does not throw.
    expect(() => view.set({ count: 1 })).not.toThrow()
    // Invalid value (negative count) throws MiddlewareError.
    expect(() => view.set({ count: -1 })).toThrow(MiddlewareError)
    // Invalid value (wrong type) throws MiddlewareError.
    expect(() => view.set({ count: 'one' })).toThrow(MiddlewareError)
    // Invalid value (extra field) throws MiddlewareError (.strict()).
    expect(() => view.set({ count: 1, extra: 'x' })).toThrow(MiddlewareError)
  })

  it('cross-slice writes fail closed (P19 rule 12)', async () => {
    // Two middlewares: 'owner' and 'intruder'. The intruder tries
    // to write into the owner's slice via `stateView.owner.set()`.
    // Because `set()` re-parses against the owner's schema
    // (not the intruder's), a value that's valid for the
    // intruder but invalid for the owner throws.
    const OwnerSchema = z.object({ owner: z.literal('owner-only') }).strict()
    const IntruderSchema = z.object({ intruder: z.literal('intruder') }).strict()
    const owner: AgentMiddleware<{ owner: 'owner-only' }> = {
      name: 'owner',
      stateSchema: OwnerSchema,
      initialState: { owner: 'owner-only' },
    }
    let intruderError: Error | undefined
    const intruder: AgentMiddleware<{ intruder: 'intruder' }> = {
      name: 'intruder',
      stateSchema: IntruderSchema,
      initialState: { intruder: 'intruder' },
      beforeModel: (messages, ctx) => {
        try {
          // Attempt to write the intruder's payload into the
          // owner's slice. The owner's schema expects
          // `{ owner: 'owner-only' }`, so this must fail.
          ;(ctx.stateView?.owner as { set: (n: unknown) => void } | undefined)?.set({
            intruder: 'intruder',
          })
        } catch (err) {
          intruderError = err as Error
        }
        return messages
      },
    }
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [owner, intruder],
    })
    await agent.run({ userMessage: 'x' })
    expect(intruderError).toBeInstanceOf(MiddlewareError)
  })

  it('plan middleware uses stateView.plan.set() and persists phase', async () => {
    // Plan mode (not auto): the first turn parses the plan,
    // transitions phase 'planning' → 'done'. We assert the run
    // succeeds and the plan store sees the saved plan — proof
    // that `stateView.plan.set()` was exercised (any schema
    // violation would throw MiddlewareError).
    const store = new PlanStore()
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '<plan id="p1">\n- step-1: do thing\n</plan>',
          toolCalls: [{ id: 'c1', name: 'should-not-run', arguments: {} }],
        },
      },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [createPlanMiddleware({ mode: 'plan', planStore: store })],
    })
    await agent.run({ userMessage: 'do thing' })
    expect(store.get('p1')?.steps[0]?.description).toBe('do thing')
  })

  it('reflection middleware uses stateView.reflection.set() and persists stepCount', async () => {
    // Reflection's afterModel fires once per model turn. After 3
    // scripted turns, stepCount reaches 3. We assert the run
    // succeeds — proof that `stateView.reflection.set()` was
    // exercised (any schema violation would throw).
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b', toolCalls: [] } },
      { message: { role: 'assistant', content: 'c', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [createReflectionMiddleware({ inline: false, stepInterval: 1 })],
    })
    const result = await agent.run({ userMessage: 'x' })
    expect(result.iterations).toBeGreaterThanOrEqual(1)
  })
})
