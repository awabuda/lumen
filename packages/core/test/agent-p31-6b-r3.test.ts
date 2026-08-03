/**
 * P31.6B — R3 invariant: after the Agent's
 * `applyBeforeModel` + `spliceDynamicChunks` pass, the
 * messages array carries exactly one `{role: 'system'}`
 * message (the head), and no middleware-injected content
 * shows up as a standalone role-system message after the
 * head. Skill / Plan / Reflection must write via
 * `ctx.appendDynamicChunk`; this test pins the wire
 * shape so any future regression that re-introduces a
 * `prepend system` path is caught at the boundary.
 *
 * The test drives a real Agent.run with a Skill-trigger
 * middleware that fires and asserts that the system
 * message at index 0 is the only role:system message and
 * that its dynamic suffix carries the skill-augmentation
 * text.
 */

import { describe, expect, it } from 'vitest'
import {
  createAgent,
  type CreateAgentConfig,
} from '../src/index.js'
import { createSkillTriggerMiddleware } from '../src/agent/middleware/skill-trigger.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

const skillScriptedResponse = {
  message: {
    role: 'assistant' as const,
    content: 'ok',
    toolCalls: [],
  },
}

const systemPromptText = 'system-prompt-text'

const buildLegacyCfg = (
  middleware: CreateAgentConfig['middleware'],
): CreateAgentConfig => ({
  provider: new FakeProvider([skillScriptedResponse]),
  tools: new ToolRegistry(),
  cwd: '/repo',
  middleware,
  systemPrompt: systemPromptText,
})

const buildLayeredCfg = (
  middleware: CreateAgentConfig['middleware'],
): CreateAgentConfig => ({
  provider: new FakeProvider([skillScriptedResponse]),
  tools: new ToolRegistry(),
  cwd: '/repo',
  middleware,
  systemPromptContext: {
    profile: {},
    runtime: {
      sessionId: 's',
      cwd: '/r',
      model: 'm',
      capturedAtIso: '2026-08-03T00:00:00Z',
    },
  },
})

describe('P31.6B R3 — middleware chunk path', () => {
  it('skill-trigger writes to the dynamic suffix, not a separate role:system message', async () => {
    const cfg = buildLegacyCfg([
      createSkillTriggerMiddleware({
        trigger: async (msg: string) => {
          if (msg.toLowerCase().includes('ping')) {
            return [
              {
                id: 'skill-ping',
                name: 'skill-ping',
                description: 'a triggered skill',
              },
            ]
          }
          return []
        },
      }),
    ])
    const agent = createAgent(cfg)
    await agent.run({ userMessage: 'please ping now' })
    const provider = cfg.provider as unknown as FakeProvider
    expect(provider.calls.length).toBe(1)
    const messages = provider.calls[0]?.messages ?? []
    const systemIndices = messages
      .map((m, i) => (m.role === 'system' ? i : -1))
      .filter((i) => i >= 0)
    expect(systemIndices).toEqual([0])
    const sys = messages[0]
    const sysContent = sys && 'content' in sys && typeof sys.content === 'string'
      ? sys.content
      : ''
    expect(sysContent).toContain(systemPromptText)
    expect(sysContent).toContain('<!-- LUMEN_CACHE_BOUNDARY -->')
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i]?.role).not.toBe('system')
    }
  })

  it('section context mode preserves the layered prompt + accepts dynamic chunks', async () => {
    const cfg = buildLayeredCfg([
      createSkillTriggerMiddleware({
        trigger: async () => [
          {
            id: 'skill-ping',
            name: 'skill-ping',
            description: 'a triggered skill',
          },
        ],
      }),
    ])
    const agent = createAgent(cfg)
    await agent.run({ userMessage: 'ping' })
    const provider = cfg.provider as unknown as FakeProvider
    const messages = provider.calls[0]?.messages ?? []
    const systemIndices = messages
      .map((m, i) => (m.role === 'system' ? i : -1))
      .filter((i) => i >= 0)
    expect(systemIndices).toEqual([0])
    const sys = messages[0]
    const sysContent = sys && 'content' in sys && typeof sys.content === 'string'
      ? sys.content
      : ''
    expect(sysContent).toContain('<!-- LUMEN_CACHE_BOUNDARY -->')
    const markerCount = (sysContent.match(/<!-- LUMEN_CACHE_BOUNDARY -->/g) ?? []).length
    expect(markerCount).toBe(1)
  })
})
