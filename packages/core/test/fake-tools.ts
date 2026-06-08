/**
 * A fake tool for testing.
 */
import { z } from 'zod'
import { BaseTool, type ToolContext, type ToolDescriptor } from '../src/tools/index.js'

export class EchoTool extends BaseTool {
  public readonly name = 'echo'
  public readonly description = 'Echoes back the input as a string.'
  public readonly inputSchema = z.object({ message: z.string() })
  public readonly risk = 'safe' as const

  protected async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    const { message } = input as { message: string }
    return { echoed: message }
  }
}

export class FailingTool extends BaseTool {
  public readonly name = 'failing'
  public readonly description = 'Always throws.'
  public readonly inputSchema = z.object({ reason: z.string().default('no reason') })
  public readonly risk = 'safe' as const

  protected async execute(_input: unknown, _ctx: ToolContext): Promise<unknown> {
    throw new Error('intentional failure')
  }
}

export class DescribeEcho extends EchoTool {
  public override describe(): ToolDescriptor {
    const d = super.describe()
    return { ...d, name: 'echo-renamed' }
  }
}
