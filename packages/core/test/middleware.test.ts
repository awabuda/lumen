/**
 * P19.0.4 — middleware 单测。
 *
 * Coverage map (TASKS.md P19.0.4):
 *   - composition order  — middleware 按注册顺序 dispatch
 *   - error short-circuit — middleware throw 时短路, 后续不跑
 *   - async parity        — beforeModel/afterModel 同时支持 sync/async 返回
 *   - HookRegistry 兼容  — 旧 HookRegistry 路径不变（间接通过 Agent.run
 *                          测试, 此处只验证 middleware spec 不破坏 hooks
 *                          的可读性, 即 hooks 类型仍可独立 import）
 *
 * Plus parseMiddleware 的边界 case:
 *   - 空 list 通过
 *   - name 缺失 / 空字符串 throw MiddlewareError
 *   - 重复 name throw MiddlewareError
 *   - stateSchema 默认 z.unknown()
 *   - stateSchema 显式提供被保留
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  type AgentMiddleware,
  type BeforeModelHook,
  type MiddlewareContext,
  MiddlewareError,
  type WrapToolCall,
  parseMiddleware,
} from '../src/agent/middleware.js'
import type { AssistantMessage, Message, ToolCall, ToolResult } from '../src/message/index.js'

const baseMessage = (role: Message['role'], content: string): Message =>
  ({ role, content }) as Message

const assistantMsg = (content: string, toolCalls: ToolCall[] = []): AssistantMessage => ({
  role: 'assistant',
  content,
  toolCalls,
})

const ctx = (overrides: Partial<MiddlewareContext> = {}): MiddlewareContext => ({
  sessionId: 's1',
  iteration: 1,
  startedAt: 0,
  state: {},
  control: { continueAfterModel: false },
  ...overrides,
})

const toolResult = (): ToolResult => ({ toolCallId: 't1', content: 'ok', isError: false })

describe('parseMiddleware', () => {
  it('accepts an empty list', () => {
    const parsed = parseMiddleware([])
    expect(parsed).toHaveLength(0)
  })

  it('parses a single middleware with no schema', () => {
    const mw: AgentMiddleware = { name: 'a' }
    const parsed = parseMiddleware([mw])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.name).toBe('a')
    expect(parsed[0]?.raw).toBe(mw)
    // stateSchema is z.unknown() by default.
    const ok = parsed[0]?.stateSchema.safeParse('anything')
    expect(ok?.success).toBe(true)
  })

  it('preserves an explicit stateSchema', () => {
    const schema = z.object({ count: z.number().int() }).strict()
    const mw: AgentMiddleware<{ count: number }> = { name: 'a', stateSchema: schema }
    const parsed = parseMiddleware([mw])
    const ok = parsed[0]?.stateSchema.safeParse({ count: 1 })
    expect(ok?.success).toBe(true)
    const bad = parsed[0]?.stateSchema.safeParse({ count: 'one' })
    expect(bad?.success).toBe(false)
  })

  it('throws MiddlewareError on missing name', () => {
    // @ts-expect-error — name is required; we test the runtime guard.
    const mw: AgentMiddleware = { name: '' }
    expect(() => parseMiddleware([mw])).toThrow(MiddlewareError)
  })

  it('throws MiddlewareError on duplicate name', () => {
    const a: AgentMiddleware = { name: 'x' }
    const b: AgentMiddleware = { name: 'x' }
    expect(() => parseMiddleware([a, b])).toThrow(/duplicate middleware name "x"/)
  })

  it('MiddlewareError carries the offending middleware name', () => {
    try {
      parseMiddleware([{ name: 'a' }, { name: 'b' }, { name: 'a' }])
      throw new Error('expected parseMiddleware to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MiddlewareError)
      const mwErr = err as MiddlewareError
      expect(mwErr.middlewareName).toBe('a')
      expect(mwErr.message).toContain('a')
      expect(mwErr.name).toBe('MiddlewareError')
    }
  })
})

describe('AgentMiddleware hook shape — composition order', () => {
  it('runs beforeModel hooks in registration order', async () => {
    const order: string[] = []
    const mwA: AgentMiddleware = {
      name: 'a',
      beforeModel: (msgs) => {
        order.push('a')
        return msgs
      },
    }
    const mwB: AgentMiddleware = {
      name: 'b',
      beforeModel: (msgs) => {
        order.push('b')
        return msgs
      },
    }
    const parsed = parseMiddleware([mwA, mwB])
    const messages: ReadonlyArray<Message> = [baseMessage('user', 'hi')]
    // P19.0.4 verifies the hook shape, not the Agent.run loop
    // (loop integration is P19.0.2). We just call the hooks in
    // order to prove registration order = dispatch order.
    for (const p of parsed) {
      if (p.raw.beforeModel) {
        await p.raw.beforeModel(messages, ctx())
      }
    }
    expect(order).toEqual(['a', 'b'])
  })

  it('runs afterModel hooks in registration order', async () => {
    const order: string[] = []
    const make = (n: string): AgentMiddleware => ({
      name: n,
      afterModel: (response) => {
        order.push(n)
        return response
      },
    })
    const parsed = parseMiddleware([make('a'), make('b'), make('c')])
    const response = assistantMsg('hi')
    for (const p of parsed) {
      if (p.raw.afterModel) {
        await p.raw.afterModel(response, ctx())
      }
    }
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

describe('AgentMiddleware hook shape — error short-circuit', () => {
  it('propagates a throw from beforeModel so the loop can abort', async () => {
    const mw: AgentMiddleware = {
      name: 'boom',
      beforeModel: () => {
        throw new Error('middleware failed before model')
      },
    }
    // Caller is responsible for catching (matches lumen rule 7: no
    // try/catch that swallows; Agent.run's middleware dispatch will
    // catch and wrap as MiddlewareError in P19.0.2).
    expect(() => mw.beforeModel?.([baseMessage('user', 'x')], ctx())).toThrow(
      /middleware failed before model/,
    )
  })

  it('a later beforeModel does not run if an earlier one throws', async () => {
    const order: string[] = []
    const mwA: AgentMiddleware = {
      name: 'a',
      beforeModel: () => {
        order.push('a')
        throw new Error('a failed')
      },
    }
    const mwB: AgentMiddleware = {
      name: 'b',
      beforeModel: () => {
        order.push('b')
        return []
      },
    }
    const parsed = parseMiddleware([mwA, mwB])
    const messages: ReadonlyArray<Message> = [baseMessage('user', 'x')]
    try {
      for (const p of parsed) {
        if (p.raw.beforeModel) {
          await p.raw.beforeModel(messages, ctx())
        }
      }
    } catch {
      // expected
    }
    expect(order).toEqual(['a'])
  })

  it('propagates a throw from wrapToolCall so the loop can abort', async () => {
    const call: WrapToolCall = async (_tool, _default) => {
      throw new Error('tool gate denied')
    }
    const tool: ToolCall = { id: 't1', name: 'read_file', arguments: {} }
    await expect(call(tool, async () => toolResult(), ctx())).rejects.toThrow(/tool gate denied/)
  })
})

describe('AgentMiddleware hook shape — async parity', () => {
  it('accepts a sync return from beforeModel', async () => {
    const beforeModel: BeforeModelHook = (msgs) => {
      // sync return — must be tolerated, not just async.
      return msgs
    }
    const out = await beforeModel([baseMessage('user', 'x')], ctx())
    expect(out).toHaveLength(1)
  })

  it('accepts an async return from afterModel', async () => {
    const afterModel = async (response: AssistantMessage): Promise<AssistantMessage> => {
      await Promise.resolve()
      return { ...response, content: `${response.content}!` }
    }
    const out = await afterModel(assistantMsg('hi'), ctx())
    expect(out.content).toBe('hi!')
  })

  it('preserves identity when a hook returns the same messages array', async () => {
    const messages: ReadonlyArray<Message> = [baseMessage('user', 'x')]
    const mw: AgentMiddleware = {
      name: 'passthrough',
      beforeModel: (msgs) => msgs,
    }
    const out = await mw.beforeModel?.(messages, ctx())
    expect(out).toBe(messages)
  })
})

describe('AgentMiddleware default state slice', () => {
  it('starts with an undefined initialState when no schema is provided', () => {
    const parsed = parseMiddleware([{ name: 'a' }])
    expect(parsed[0]?.initialState).toBeUndefined()
  })

  it('starts with undefined initialState even when stateSchema is typed', () => {
    const schema = z.object({ x: z.number() }).strict()
    const parsed = parseMiddleware<{ x: number }>([{ name: 'a', stateSchema: schema }])
    // The P19.0.4 contract: initialState is undefined until a `set`
    // writer is called. P19.1 will introduce the writer; P19.0 only
    // requires the slice exists in the parsed struct.
    expect(parsed[0]?.initialState).toBeUndefined()
    expect(parsed[0]?.stateSchema.safeParse({ x: 1 }).success).toBe(true)
  })
})

describe('MiddlewareError (typed error taxonomy)', () => {
  it('extends Error and carries middlewareName + message', () => {
    const err = new MiddlewareError('bad state', 'plan')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(MiddlewareError)
    expect(err.middlewareName).toBe('plan')
    expect(err.message).toContain('[middleware:plan]')
    expect(err.message).toContain('bad state')
  })

  it('accepts a cause and forwards it to Error.cause', () => {
    const inner = new Error('underlying')
    const err = new MiddlewareError('wrap', 'plan', inner)
    expect(err.cause).toBe(inner)
  })
})
