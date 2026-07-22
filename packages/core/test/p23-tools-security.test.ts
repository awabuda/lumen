/**
 * P23.10 — tools/security + small quality fixes (fix #12, #13,
 * #19, #33, #35, #36, #45, #46).
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  BaseSkill,
  type SkillApplication,
  type SkillContext,
  globLikeMatch,
} from '../../skills/src/base.js'
import { SkillRegistry } from '../../skills/src/registry.js'
import { ProviderPoolOptionsSchema } from '../src/agent/pool.js'
import { ValidationError } from '../src/errors/index.js'
import { HookRegistry } from '../src/hooks/index.js'
import { BaseLogger } from '../src/logging/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { createTrace } from '../src/trace.js'

// ---------------------------------------------------------------------------
// fix #12 — buildRestrictedRegistry warns on unknown tool
// ---------------------------------------------------------------------------

describe('P23.10 — fix #12: buildRestrictedRegistry warns on unknown allowedTools', () => {
  it('emits a warning when an allowedTools entry has no match', async () => {
    const warnings: { msg: string; context?: Record<string, unknown> }[] = []
    const logger = {
      warn: (msg: string, context?: Record<string, unknown>) => {
        warnings.push({ msg, context })
      },
    }
    const { createSubAgent } = await import('../src/agent/sub-agent.js')
    const tools = new ToolRegistry()
    // P23.10 — `createSubAgent`'s 4th positional arg is the
    // logger; the 3rd is `parentMiddleware`. Previous P23.10
    // test passed `logger` as the 3rd arg so it landed on
    // `parentMiddleware` and was forwarded nowhere.
    createSubAgent(
      { provider: { id: 'stub' } as never, tools, model: 'm' },
      {
        goal: 'x',
        allowedTools: ['not_a_real_tool', 'another_unknown'],
      },
      undefined,
      logger as never,
    )
    expect(warnings.length).toBeGreaterThanOrEqual(2)
    expect(warnings.every((w) => w.msg.includes('no match'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fix #13 — ProviderPoolOptionsSchema accepts circuit
// ---------------------------------------------------------------------------

describe('P23.10 — fix #13: ProviderPoolOptionsSchema accepts circuit', () => {
  it('parses a config with a circuit breaker', () => {
    const circuit = {
      allow: () => undefined,
      recordSuccess: () => undefined,
      recordFailure: () => undefined,
    }
    const parsed = ProviderPoolOptionsSchema.parse({ circuit })
    expect(parsed.circuit).toBe(circuit)
  })
})

// ---------------------------------------------------------------------------
// fix #19 — ToolRegistry logs a debug message on duplicate
// ---------------------------------------------------------------------------

describe('P23.10 — fix #19: ToolRegistry debug log on duplicate toolset names', () => {
  it('calls console.debug when materializing a duplicate name', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    try {
      const reg = new ToolRegistry()
      // P23.10 — the original test relied on two distinct toolset
      // ids colliding on the same tool name after namespacing, but
      // `materializeToolset` namespaces as `${toolset.id}:${tool.name}`,
      // so `ts1:shared` vs `ts2:shared` never actually duplicate. The
      // realistic conflict is: an eager-registered toolset owns
      // `ts1:shared`, then a sibling toolset's eager materialize
      // collides when `namespace: false` flattens both to `shared`.
      const baseToolA = {
        name: 'shared',
        description: 'a',
        inputSchema: z.object({}),
        risk: 'safe' as const,
        version: '0.0.0',
      }
      const baseToolB = {
        name: 'shared',
        description: 'b',
        inputSchema: z.object({}),
        risk: 'safe' as const,
        version: '0.0.0',
      }
      const ts1 = { id: 'ts1', materialize: () => [baseToolA as never] }
      const ts2 = { id: 'ts2', materialize: () => [baseToolB as never] }
      // Eager-register the first toolset with `namespace: false` so
      // its tool lands under the bare name `shared`, then eager-register
      // the second toolset the same way — the duplicate detection in
      // `materializeToolset` fires `console.debug`.
      reg.registerToolset(ts1 as never, { eager: true, namespace: false })
      reg.registerToolset(ts2 as never, { eager: true, namespace: false })
      expect(debugSpy).toHaveBeenCalled()
      const calls = debugSpy.mock.calls.map((c) => String(c[0]))
      expect(calls.some((c) => c.includes('skipping duplicate tool'))).toBe(true)
    } finally {
      debugSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// fix #33 — BaseCron.run re-entry guard
// ---------------------------------------------------------------------------

describe('P23.10 — fix #33: BaseCron.run re-entry guard', () => {
  it('IntervalCron records multiple sequential run() invocations', async () => {
    const { IntervalCron } = await import('../src/cron/index.js')
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new IntervalCron({ id: 'g1', intervalMs: 10000, job })
    await cron.run()
    await cron.run()
    expect(cron.history).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// fix #35 — SkillRegistry activate/apply parallel
// ---------------------------------------------------------------------------

class StubSkill extends BaseSkill {
  public readonly id: string
  public readonly name = 'stub'
  public readonly description = 'stub'
  public readonly triggers: ReadonlyArray<{
    kind: 'always'
    value: string
    weight?: number
  }> = [{ kind: 'always', value: '*' }]
  public constructor(id: string) {
    super()
    this.id = id
  }
  public async shouldActivate(_ctx: SkillContext): Promise<{
    active: boolean
    score: number
    reason: string
  }> {
    return { active: true, score: 0.5, reason: 'always' }
  }
  public async apply(_ctx: SkillContext): Promise<SkillApplication> {
    return { instructions: this.id }
  }
}

describe('P23.10 — fix #35: SkillRegistry parallel activate/apply', () => {
  it('activate scores all skills and returns the same set as serial', async () => {
    const reg = new SkillRegistry()
    reg.register(new StubSkill('a'))
    reg.register(new StubSkill('b'))
    reg.register(new StubSkill('c'))
    const out = await reg.activate({ cwd: '/' })
    expect(out).toHaveLength(3)
    expect(out.map((a) => a.skill.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('applyActive returns one application per active skill', async () => {
    const reg = new SkillRegistry()
    reg.register(new StubSkill('x'))
    reg.register(new StubSkill('y'))
    const apps = await reg.applyActive({ cwd: '/' })
    expect(apps).toHaveLength(2)
    expect(apps.map((a) => a.instructions).sort()).toEqual(['x', 'y'])
  })
})

// ---------------------------------------------------------------------------
// fix #36 — globLikeMatch partial match when pattern has *
// ---------------------------------------------------------------------------

describe('P23.10 — fix #36: globLikeMatch partial match with *', () => {
  it('matches foo* against foobar/baz (substring)', () => {
    expect(globLikeMatch('foo*', 'foobar/baz')).toBe(true)
  })

  it('matches *foo* against myfoobar (substring)', () => {
    expect(globLikeMatch('*foo*', 'myfoobar')).toBe(true)
  })

  it('still anchors literal patterns (no *)', () => {
    expect(globLikeMatch('foo', 'foo')).toBe(true)
    expect(globLikeMatch('foo', 'foobar')).toBe(false)
  })

  it('matches * alone (the wildcard-only shortcut)', () => {
    expect(globLikeMatch('*', 'anything')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// fix #45 — createTrace throws ValidationError
// ---------------------------------------------------------------------------

describe('P23.10 — fix #45: createTrace throws ValidationError', () => {
  it('throws ValidationError on bad traceId', () => {
    expect(() => createTrace({ traceId: 'not-hex' })).toThrow(ValidationError)
  })

  it('throws ValidationError on bad spanId', () => {
    expect(() => createTrace({ spanId: 'xyz' })).toThrow(ValidationError)
  })

  it('throws ValidationError on bad parentSpanId', () => {
    expect(() => createTrace({ parentSpanId: 'bad' })).toThrow(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// fix #46 — HookRegistry routes errors through optional logger
// ---------------------------------------------------------------------------

class RecordingLogger extends BaseLogger {
  public readonly id = 'rec'
  public readonly errors: { msg: string; context?: Record<string, unknown> }[] = []
  public error(msg: string, context?: Record<string, unknown>): void {
    this.errors.push({ msg, context })
  }
  public debug(): void {}
  public info(): void {}
  public warn(): void {}
  public child(): BaseLogger {
    return this
  }
}

describe('P23.10 — fix #46: HookRegistry optional logger', () => {
  it('routes hook errors through the logger when one is provided', async () => {
    const logger = new RecordingLogger()
    const reg = new HookRegistry({ logger })
    reg.register(async () => {
      throw new Error('hook-bug')
    })
    await reg.dispatch(
      { kind: 'run:start', sessionId: 's', userMessage: 'hi' },
      { sessionId: 's', iteration: 0, startedAt: Date.now() },
    )
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]?.msg).toBe('hook threw')
    expect(logger.errors[0]?.context?.error).toBe('hook-bug')
  })

  it('falls back to console.error when no logger is provided', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const reg = new HookRegistry()
      reg.register(async () => {
        throw new Error('no-logger-bug')
      })
      await reg.dispatch(
        { kind: 'run:start', sessionId: 's', userMessage: 'hi' },
        { sessionId: 's', iteration: 0, startedAt: Date.now() },
      )
      expect(errSpy).toHaveBeenCalled()
      const calls = errSpy.mock.calls.map((c) => String(c[0]))
      expect(calls.some((c) => c.includes('hook threw'))).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })
})
