import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core'
/**
 * `env` — read a single environment variable.
 *
 * The agent can ask for a specific env var by name. The tool
 * never returns the value of variables that look like secrets
 * (names containing KEY, SECRET, TOKEN, PASSWORD, CREDENTIAL
 * are redacted to [REDACTED]). This is a deliberate guardrail.
 *
 * Risk: 'safe' (read-only, no side effects).
 */
import { z } from 'zod'

export const EnvInputSchema = z.object({
  name: z.string().min(1).max(256),
})
export type EnvInput = z.infer<typeof EnvInputSchema>

export const EnvOutputSchema = z.object({
  name: z.string(),
  value: z.string().nullable(),
  redacted: z.boolean(),
})
export type EnvOutput = z.infer<typeof EnvOutputSchema>

const SECRET_RE = /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY)(?:_|$)/i

export class EnvTool extends BaseTool {
  public readonly name = 'env'
  public readonly description =
    'Read a single environment variable by name. Values that look like secrets are redacted.'
  public readonly inputSchema: z.ZodType<unknown> = EnvInputSchema
  public readonly risk: ToolRisk = 'safe'
  public override readonly version = '0.1.0'

  protected async execute(input: unknown, _ctx: ToolContext): Promise<EnvOutput> {
    const { name } = input as EnvInput
    const raw = process.env[name]
    if (raw === undefined) {
      return { name, value: null, redacted: false }
    }
    if (SECRET_RE.test(name)) {
      return { name, value: '[REDACTED]', redacted: true }
    }
    return { name, value: raw, redacted: false }
  }
}
