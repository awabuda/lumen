/**
 * P23.2 — sub-agent inherits parent's middleware (bug #2 + #14).
 *
 * Before P23.2:
 *   - `createSubAgent` and `createSubAgentFromSpec` built the child
 *     Agent via `new Agent({...parent, ...})`, dropping the
 *     `middleware` field (which is symbol-keyed via `createAgent`).
 *   - `SubAgentMiddlewareOptions.parent` did not expose middleware.
 *
 * After P23.2:
 *   - Both helpers accept an optional `parentMiddleware` arg and
 *     route through `createAgent` when the list is non-empty.
 *   - `SubAgentMiddlewareOptions.parent.middleware` carries the
 *     list to the spawned sub-agent (and the handoff / supervisor
 *     paths inherit it through the same channel).
 *
 * Tests use a recording middleware whose `beforeModel` appends a
 * unique marker into the messages stream. The marker must land in
 * the **child** agent's recorded FakeProvider call — proof that
 * the parent's middleware propagated to the sub-agent's
 * `AGENT_MIDDLEWARE` symbol (via `createAgent`).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/factory.js'
import type { AgentMiddleware } from '../src/agent/middleware.js'
import {
  SUB_AGENT_TOOL_NAME,
  SubAgentTaskTool,
  createSubAgentMiddleware,
} from '../src/agent/middleware/sub-agent.js'
import { createSubAgent, createSubAgentFromSpec } from '../src/agent/sub-agent.js'
import type { Message } from '../src/message/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

/** True when the message is a plain `{ role, content: string }`. */
const messageHasStringContent = (m: { content: unknown }): m is { role: string; content: string } =>
  typeof m.content === 'string'

/**
 * Build a recording middleware that appends a unique marker to
 * the messages stream. The marker must reach the sub-agent's
 * recorded provider call to confirm propagation.
 */
const buildRecorder = (marker: string): AgentMiddleware => ({
  name: 'recorder',
  stateSchema: z.object({}).strict(),
  initialState: {},
  beforeModel: async (messages) => [
    ...messages,
    { role: 'system', content: marker } as unknown as Message,
  ],
})

/** True when any of the recorded messages carries `marker`. */
const providerSawMarker = (provider: FakeProvider, marker: string): boolean =>
  provider.calls.some((c) =>
    c.messages.some((m) => messageHasStringContent(m) && m.content === marker),
  )

describe('P23.2 — createSubAgent inherits parent middleware', () => {
  it('routes through createAgent when parentMiddleware is non-empty (marker lands on child)', async () => {
    const MARKER = '<<recorder-marker-p23-2-create-sub>>'
    const recorder = buildRecorder(MARKER)
    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'sub', toolCalls: [] } },
    ])
    const sub = createSubAgent(
      { provider: subProvider, tools: new ToolRegistry() },
      { goal: 'do x' },
      [recorder],
    )

    await sub.run()

    expect(providerSawMarker(subProvider, MARKER)).toBe(true)
  })

  it('preserves pre-P23.2 behaviour when parentMiddleware is omitted', async () => {
    const MARKER = '<<should-not-appear-create-sub>>'
    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'sub', toolCalls: [] } },
    ])
    const sub = createSubAgent(
      { provider: subProvider, tools: new ToolRegistry() },
      { goal: 'do x' },
    )

    await sub.run()

    expect(providerSawMarker(subProvider, MARKER)).toBe(false)
  })

  it('preserves pre-P23.2 behaviour when parentMiddleware is empty', async () => {
    const sub = createSubAgent(
      {
        provider: new FakeProvider([
          { message: { role: 'assistant', content: 'sub', toolCalls: [] } },
        ]),
        tools: new ToolRegistry(),
      },
      { goal: 'do x' },
      [],
    )
    const result = await sub.run()
    expect(result.finalMessage.content).toBe('sub')
  })

  it('rejects duplicate middleware names via createAgent validation', () => {
    expect(() =>
      createSubAgent(
        {
          provider: new FakeProvider([
            { message: { role: 'assistant', content: 'sub', toolCalls: [] } },
          ]),
          tools: new ToolRegistry(),
        },
        { goal: 'x' },
        [buildRecorder('a'), buildRecorder('a')],
      ),
    ).toThrow(/duplicate middleware name/i)
  })
})

describe('P23.2 — createSubAgentFromSpec inherits parent middleware', () => {
  it('propagates parentMiddleware to the spawned sub-agent', async () => {
    const MARKER = '<<recorder-marker-p23-2-create-from-spec>>'
    const recorder = buildRecorder(MARKER)
    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'sub', toolCalls: [] } },
    ])
    const sub = createSubAgentFromSpec(
      { provider: subProvider, tools: new ToolRegistry() },
      {
        name: 'researcher',
        description: 'Researches a topic',
        systemPrompt: 'You research.',
      },
      'find x',
      5,
      [recorder],
    )

    await sub.run()

    expect(providerSawMarker(subProvider, MARKER)).toBe(true)
  })

  it('still works when parentMiddleware is omitted (back-compat)', async () => {
    const sub = createSubAgentFromSpec(
      {
        provider: new FakeProvider([
          { message: { role: 'assistant', content: 'sub', toolCalls: [] } },
        ]),
        tools: new ToolRegistry(),
      },
      {
        name: 'researcher',
        description: 'Researches a topic',
        systemPrompt: 'You research.',
      },
      'find x',
    )

    const result = await sub.run()
    expect(result.finalMessage.content).toBe('sub')
  })
})

describe('P23.2 — SubAgentMiddleware forwards parent.middleware', () => {
  it('attaches parent middleware to the spawned sub-agent', async () => {
    const MARKER = '<<forwarded-marker-p23-2>>'
    const recorder = buildRecorder(MARKER)

    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'sub result', toolCalls: [] } },
    ])
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    const parentProvider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: SUB_AGENT_TOOL_NAME,
              arguments: { subagent: 'researcher', prompt: 'find info' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'parent done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider: parentProvider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: {
            provider: subProvider,
            tools: new ToolRegistry(),
            middleware: [recorder],
          },
          specs: [
            {
              name: 'researcher',
              description: 'Researches a topic',
              systemPrompt: 'You research.',
            },
          ],
        }),
      ],
    })

    const result = await agent.run({ userMessage: 'do it' })

    expect(result.finalMessage.content).toBe('parent done')
    // The recorder ran on the sub-agent — the marker landed in
    // the child's call to subProvider.
    expect(subProvider.calls.length).toBeGreaterThan(0)
    expect(providerSawMarker(subProvider, MARKER)).toBe(true)
    // The parent's own provider should NOT contain the marker —
    // its middleware list has only SubAgentMiddleware, not the
    // recorder.
    expect(providerSawMarker(parentProvider, MARKER)).toBe(false)
  })

  it('runs cleanly when parent.middleware is omitted (back-compat)', async () => {
    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'sub result', toolCalls: [] } },
    ])
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    const parentProvider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: SUB_AGENT_TOOL_NAME,
              arguments: { subagent: 'researcher', prompt: 'find info' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'parent done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider: parentProvider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: {
            provider: subProvider,
            tools: new ToolRegistry(),
            // middleware intentionally omitted — pre-P23.2 path.
          },
          specs: [
            {
              name: 'researcher',
              description: 'Researches a topic',
              systemPrompt: 'You research.',
            },
          ],
        }),
      ],
    })

    const result = await agent.run({ userMessage: 'do it' })

    expect(result.finalMessage.content).toBe('parent done')
    expect(subProvider.calls.length).toBeGreaterThan(0)
  })
})
