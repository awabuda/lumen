/**
 * P31.6 — Agent accepts a SectionContext and renders it
 * through `buildSystemPrompt` at construction time. Pinned
 * by cases covering the mutuality rule + the legacy
 * fallback + the rendered-prompt signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Agent,
  type AgentConfig,
  type ChatRequest,
} from '../src/index.js'
import type { BaseLogger, LogLevel } from '../src/logging/index.js'
import type { Message } from '../src/message/index.js'
import { ValidationError } from '../src/errors/index.js'

const silentLogger = (): BaseLogger => {
  const noop = (): void => {}
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    setLevel: (_level: LogLevel): void => {},
    child: (): BaseLogger => silentLogger(),
  } as unknown as BaseLogger
}

/** Capture-only fake provider. */
const fakeProvider = {
  id: 'fake',
  capabilities: {
    maxContextTokens: 8192,
    toolCalls: true,
    parallelToolCalls: true,
    promptCaching: false,
    streamable: false,
    vision: false,
    jsonMode: false,
  },
  chat: vi.fn(
    async (
      _request: ChatRequest,
    ): Promise<{ content: string; messages: ReadonlyArray<Message> }> => {
      return { content: '', messages: [] }
    },
  ),
  embed: undefined,
  stream: undefined,
} as unknown as AgentConfig['provider']

const cfg: AgentConfig = {
  provider: fakeProvider,
  // biome-ignore lint/suspicious/noExplicitAny: test scaffolding only.
  tools: {} as any,
  cwd: '/repo',
  logger: silentLogger(),
}

const baseRuntime = {
  sessionId: 's_test',
  cwd: '/repo',
  model: 'fake-model',
  capturedAtIso: '2026-08-03T00:00:00Z',
}

describe('Agent + systemPromptContext (P31.6)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws when both systemPrompt and systemPromptContext are provided', () => {
    const cfgBoth: AgentConfig = {
      ...cfg,
      systemPrompt: 'legacy string',
      systemPromptContext: {
        profile: {},
        runtime: baseRuntime,
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: test scaffolding only.
    expect(() => new Agent(cfgBoth as any)).toThrow(ValidationError)
  })

  it('uses systemPromptContext to render the layered prompt when provided', () => {
    const promptText = 'LAYERED PROMPT'
    const cfgLayered: AgentConfig = {
      ...cfg,
      // Override project text so the rendered prompt contains a
      // distinctive marker we can assert on.
      systemPromptContext: {
        profile: {},
        projectText: promptText,
        runtime: baseRuntime,
      },
    }
    const agent = new Agent(cfgLayered)
    // Internal access for the test only — we sniff the rendered
    // system prompt the Agent stored at construction time.
    const rendered = (agent as unknown as { systemPrompt: string }).systemPrompt
    expect(rendered).toContain(promptText)
    // R1 regression: no schema dump markers.
    expect(rendered).not.toContain('"parameters":')
    // Boundary primitive: K0+K1+K2+G1+... string carries marker.
    expect(rendered).toContain('<!-- LUMEN_CACHE_BOUNDARY -->')
  })

  it('falls back to the legacy single-string prompt when no SectionContext is given', () => {
    const cfgLegacy: AgentConfig = {
      ...cfg,
      systemPrompt: 'legacy only',
    }
    const agent = new Agent(cfgLegacy)
    expect((agent as unknown as { systemPrompt: string }).systemPrompt).toBe(
      'legacy only',
    )
  })

  it('falls back to the canonical default when neither is given', () => {
    const agent = new Agent(cfg)
    const rendered = (agent as unknown as { systemPrompt: string }).systemPrompt
    // KERNEL_TEXT opens the default render.
    expect(rendered).toMatch(/You are Lumen/)
  })
})
