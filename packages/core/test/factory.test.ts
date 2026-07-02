/**
 * P19.0.3 — createAgent factory 单测。
 *
 * Coverage map (TASKS.md P19.0.3 spirit — P19.0.3 ships the
 * factory entry point, not the Agent.run wire-up):
 *   - createAgent(config) returns an Agent instance
 *   - createAgent({middleware: []}) 行为等价于无 middleware
 *   - createAgent({middleware: [...]}) 把 parsed list 附在
 *     AGENT_MIDDLEWARE symbol 上, getAgentMiddleware 能读回
 *   - createAgent({middleware: [bad]}) throws MiddlewareError
 *   - createAgent 不传 middleware / 传空数组 → getAgentMiddleware
 *     返回 []
 *   - createAgent 接受 AgentConfig 全字段（继承）
 *
 * 这些测试是 P19.0.3 的契约保证。P19.0.2 的 wire-up 测试会
 * 验证 dispatch 行为（hook 在 Agent.run 跑时被调），本文件
 * 只覆盖 factory 这一层。
 */

import { describe, expect, it } from 'vitest'

import {
  AGENT_MIDDLEWARE,
  type CreateAgentConfig,
  createAgent,
  getAgentMiddleware,
} from '../src/agent/factory.js'
import { Agent } from '../src/agent/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

/** A scripted provider that emits one short assistant message and then
 *  returns end-of-stream. Sufficient for factory-level tests that never
 *  call `agent.run()`. */
const noopProvider = (): FakeProvider =>
  new FakeProvider([
    {
      message: { role: 'assistant', content: 'ok', toolCalls: [] },
    },
  ])

const baseConfig = (): Omit<CreateAgentConfig, 'provider' | 'tools'> & {
  provider: FakeProvider
  tools: ToolRegistry
} => {
  const provider = noopProvider()
  const tools = new ToolRegistry()
  return { provider, tools }
}

describe('createAgent', () => {
  it('returns an Agent instance', () => {
    const cfg = baseConfig()
    const agent = createAgent(cfg)
    expect(agent).toBeInstanceOf(Agent)
  })

  it('accepts an empty middleware list (treated like no middleware)', () => {
    const cfg = baseConfig()
    const agent = createAgent({ ...cfg, middleware: [] })
    expect(getAgentMiddleware(agent)).toEqual([])
  })

  it('omitted middleware is treated like an empty list', () => {
    const cfg = baseConfig()
    const agent = createAgent(cfg)
    expect(getAgentMiddleware(agent)).toEqual([])
  })

  it('attaches a parsed middleware list to the agent under AGENT_MIDDLEWARE', () => {
    const cfg = baseConfig()
    const agent = createAgent({
      ...cfg,
      middleware: [{ name: 'a' }, { name: 'b' }],
    })
    const list = getAgentMiddleware(agent)
    expect(list).toHaveLength(2)
    expect(list[0]?.name).toBe('a')
    expect(list[1]?.name).toBe('b')
  })

  it('preserves the user-provided middleware order', () => {
    const cfg = baseConfig()
    const agent = createAgent({
      ...cfg,
      middleware: [{ name: 'first' }, { name: 'second' }, { name: 'third' }],
    })
    expect(getAgentMiddleware(agent).map((m) => m.name)).toEqual(['first', 'second', 'third'])
  })

  it('throws MiddlewareError on duplicate middleware names (validation is eager)', () => {
    const cfg = baseConfig()
    expect(() =>
      createAgent({
        ...cfg,
        middleware: [{ name: 'x' }, { name: 'x' }],
      }),
    ).toThrow(/duplicate middleware name "x"/)
  })

  it('throws MiddlewareError on missing middleware name', () => {
    const cfg = baseConfig()
    expect(() =>
      createAgent({
        ...cfg,
        middleware: [{ name: '' }],
      }),
    ).toThrow(/name must be a non-empty string/)
  })

  it('AGENT_MIDDLEWARE is a Symbol (not a string, so external code cannot collide)', () => {
    expect(typeof AGENT_MIDDLEWARE).toBe('symbol')
  })

  it('passes through AgentConfig fields unchanged (provider / tools identity preserved)', () => {
    const cfg = baseConfig()
    const agent = createAgent(cfg)
    // Use a typed record cast (same pattern as factory.ts) instead of
    // `as any`. The `provider` / `tools` fields are private on Agent
    // today, so we go through `unknown` rather than changing Agent's
    // surface. P19.0.2 will introduce a public accessor.
    const a = agent as unknown as {
      readonly provider: FakeProvider
      readonly tools: ToolRegistry
    }
    expect(a.provider).toBe(cfg.provider)
    expect(a.tools).toBe(cfg.tools)
  })
})

describe('getAgentMiddleware', () => {
  it('returns [] for a bare `new Agent(...)` instance (factory is additive)', () => {
    const cfg = baseConfig()
    const bareAgent = new Agent(cfg)
    // The bare Agent was never tagged by the factory. getAgentMiddleware
    // must tolerate this and return [] so P19.0.2 can iterate the
    // list unconditionally.
    expect(getAgentMiddleware(bareAgent)).toEqual([])
  })

  it('returns the same reference on repeated calls (no re-parsing)', () => {
    const cfg = baseConfig()
    const agent = createAgent({ ...cfg, middleware: [{ name: 'a' }] })
    const a = getAgentMiddleware(agent)
    const b = getAgentMiddleware(agent)
    expect(a).toBe(b)
  })
})
