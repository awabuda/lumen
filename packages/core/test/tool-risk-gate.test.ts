/**
 * P33.B Day3 — ToolRisk dispatch gate tests.
 *
 * OPTIMIZATION-PLAN §2 A.2: `dispatchToolCall` reads
 * the tool's `risk` field and routes
 * `approval-required` / `dangerous` calls through the
 * approver (DI callback) before invoking the tool.
 * `safe` tools dispatch unchanged. The approver is a
 * callback (NOT a boolean flag) per P19+ rule 11.
 *
 * Decision matrix covered below:
 *
 * | risk               | approver  | expected outcome                        |
 * |--------------------|-----------|-----------------------------------------|
 * | `safe`             | n/a       | tool runs                               |
 * | `approval-required`| undefined | refusal (isError: true)                 |
 * | `approval-required`| deny      | refusal (isError: true)                 |
 * | `approval-required`| allow     | tool runs                               |
 * | `dangerous`        | undefined | hard deny (isError: true)               |
 * | `dangerous`        | deny      | hard deny (isError: true)               |
 * | `dangerous`        | allow     | tool runs                               |
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, BaseTool, type ToolContext, ToolRegistry, type ToolRisk } from '../src/index.js'
import type { ToolCall } from '../src/message/index.js'
import { FakeProvider } from './fake-provider.js'

class EchoTool extends BaseTool {
  public override readonly name = 'echo'
  public override readonly description = 'records the input it received'
  public override readonly inputSchema = z.object({ message: z.string() })
  public readonly observed: string[] = []

  public constructor(public override readonly risk: ToolRisk = 'safe') {
    super()
  }

  protected override async execute(
    input: { message: string },
    _ctx: ToolContext,
  ): Promise<{ echoed: string }> {
    this.observed.push(input.message)
    return { echoed: input.message }
  }
}

type ApproverFn = NonNullable<ConstructorParameters<typeof Agent>[0]['approver']>

const toolCallEcho = (id: string): ToolCall => ({
  id,
  name: 'echo',
  arguments: { message: 'hi' },
})

/**
 * Two-step scripted provider: emits one tool-call on
 * the first user turn, then a final assistant text on
 * the second. The agent loop runs two iterations.
 */
const twoTurnToolCall = (id: string) =>
  new FakeProvider([
    { message: { role: 'assistant', content: '', toolCalls: [toolCallEcho(id)] } },
    { message: { role: 'assistant', content: 'done', toolCalls: [] } },
  ])

const buildAgent = async (tool: EchoTool, approver?: ApproverFn): Promise<Agent> => {
  const provider = twoTurnToolCall('call-1')
  const tools = new ToolRegistry()
  tools.register(tool)
  if (approver !== undefined) {
    return new Agent({ provider, tools, approver })
  }
  return new Agent({ provider, tools })
}

describe('Agent.dispatchToolCall — P33.B Day3 ToolRisk gate', () => {
  it('safe tools dispatch without an approver', async () => {
    const echo = new EchoTool('safe')
    const agent = await buildAgent(echo)
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual(['hi'])
    expect(result.finalMessage.content).toBe('done')
  })

  it('approval-required without approver returns a refusal result', async () => {
    const echo = new EchoTool('approval-required')
    const agent = await buildAgent(echo)
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual([])
    const toolMsg = result.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.results[0]?.isError).toBe(true)
    expect(toolMsg?.results[0]?.content).toMatch(/approval-required/)
  })

  it('approval-required with approver deny returns a refusal result', async () => {
    const echo = new EchoTool('approval-required')
    const agent = await buildAgent(echo, async () => 'deny')
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual([])
    const toolMsg = result.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.results[0]?.content).toMatch(/denied by approver/)
  })

  it('approval-required with approver allow dispatches the tool', async () => {
    const echo = new EchoTool('approval-required')
    const agent = await buildAgent(echo, async () => 'allow')
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual(['hi'])
    expect(result.finalMessage.content).toBe('done')
  })

  it('dangerous without approver hard-denies', async () => {
    const echo = new EchoTool('dangerous')
    const agent = await buildAgent(echo)
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual([])
    const toolMsg = result.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.results[0]?.content).toMatch(/dangerous/)
  })

  it('dangerous with approver deny hard-denies', async () => {
    const echo = new EchoTool('dangerous')
    const agent = await buildAgent(echo, async () => 'deny')
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual([])
    const toolMsg = result.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.results[0]?.content).toMatch(/dangerous/)
  })

  it('dangerous with approver allow dispatches the tool', async () => {
    const echo = new EchoTool('dangerous')
    const agent = await buildAgent(echo, async () => 'allow')
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual(['hi'])
    expect(result.finalMessage.content).toBe('done')
  })

  it('approver that throws is treated as deny', async () => {
    const echo = new EchoTool('dangerous')
    const agent = await buildAgent(echo, async () => {
      throw new Error('boom')
    })
    const result = await agent.run({ userMessage: 'go' })
    expect(echo.observed).toEqual([])
    const toolMsg = result.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.results[0]?.content).toMatch(/Approver for "echo" threw boom/)
  })

  it('approver sees the actual tool + call + risk', async () => {
    const seen: { name: string; risk: string; id: string }[] = []
    const echo = new EchoTool('approval-required')
    const agent = await buildAgent(echo, async ({ tool, call, risk }) => {
      seen.push({ name: tool.name, risk, id: call.id })
      return 'allow'
    })
    await agent.run({ userMessage: 'go' })
    expect(seen).toEqual([{ name: 'echo', risk: 'approval-required', id: 'call-1' }])
  })

  it('workspaceRoot threads into ToolContext (default = cwd)', async () => {
    let captured: string | undefined
    class CaptureTool extends BaseTool {
      public override readonly name = 'capture'
      public override readonly description = 'captures the workspaceRoot it received'
      public override readonly inputSchema = z.object({})
      public override readonly risk: ToolRisk = 'safe'

      protected override async execute(_input: unknown, ctx: ToolContext): Promise<{ ok: true }> {
        captured = ctx.workspaceRoot
        return { ok: true }
      }
    }
    const capture = new CaptureTool()
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'capture', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const tools = new ToolRegistry()
    tools.register(capture)
    const agent = new Agent({ provider, tools, cwd: '/tmp/agent-root' })
    await agent.run({ userMessage: 'go' })
    expect(captured).toBe('/tmp/agent-root')
  })

  it('explicit workspaceRoot overrides cwd', async () => {
    let captured: string | undefined
    class CaptureTool extends BaseTool {
      public override readonly name = 'capture'
      public override readonly description = 'captures the workspaceRoot it received'
      public override readonly inputSchema = z.object({})
      public override readonly risk: ToolRisk = 'safe'

      protected override async execute(_input: unknown, ctx: ToolContext): Promise<{ ok: true }> {
        captured = ctx.workspaceRoot
        return { ok: true }
      }
    }
    const capture = new CaptureTool()
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-3', name: 'capture', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const tools = new ToolRegistry()
    tools.register(capture)
    const agent = new Agent({
      provider,
      tools,
      cwd: '/tmp/agent-root',
      workspaceRoot: '/srv/locked-workspace',
    })
    await agent.run({ userMessage: 'go' })
    expect(captured).toBe('/srv/locked-workspace')
  })
})
