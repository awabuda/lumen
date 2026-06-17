import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolValidationError } from '../src/errors/index.js'
import { BaseTool, type ToolContext, type ToolDescriptor } from '../src/tools/index.js'
import { EchoTool, FailingTool } from './fake-tools.js'

describe('BaseTool', () => {
  it('validates input against the schema before executing', async () => {
    const tool = new EchoTool()
    const ctx: ToolContext = {
      cwd: '/tmp',
      signal: new AbortController().signal,
      sessionId: 'test',
    }
    // Valid input
    const result = await tool.call({ message: 'hi' }, ctx)
    expect(result).toEqual({ echoed: 'hi' })
  })

  it('throws ToolValidationError on bad input', async () => {
    const tool = new EchoTool()
    const ctx: ToolContext = {
      cwd: '/tmp',
      signal: new AbortController().signal,
      sessionId: 'test',
    }
    await expect(tool.call({ message: 42 }, ctx)).rejects.toBeInstanceOf(ToolValidationError)
  })

  it('wraps unknown errors as ToolError', async () => {
    const tool = new FailingTool()
    const ctx: ToolContext = {
      cwd: '/tmp',
      signal: new AbortController().signal,
      sessionId: 'test',
    }
    await expect(tool.call({}, ctx)).rejects.toThrow(/Tool failing failed/)
  })

  it('produces a JSON Schema descriptor for providers', () => {
    const tool = new EchoTool()
    const desc: ToolDescriptor = tool.describe()
    expect(desc.name).toBe('echo')
    expect(desc.risk).toBe('safe')
    expect(desc.inputJsonSchema).toMatchObject({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    })
  })
})

// Verify a subclass can override describe().
describe('BaseTool subclassing', () => {
  class CustomDescribeTool extends BaseTool {
    public readonly name = 'custom'
    public readonly description = 'A custom tool'
    public readonly inputSchema = z.object({})
    public readonly risk = 'safe' as const
    protected async execute(_input: unknown, _ctx: ToolContext): Promise<unknown> {
      return 'ok'
    }
  }
  it('subclasses can override describe()', () => {
    class EvenMoreCustom extends CustomDescribeTool {
      public override describe(): ToolDescriptor {
        return { ...super.describe(), name: 'renamed' }
      }
    }
    const t = new EvenMoreCustom()
    expect(t.describe().name).toBe('renamed')
  })
})
