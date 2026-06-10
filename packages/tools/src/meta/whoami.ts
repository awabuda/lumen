/**
 * `whoami` — current OS user, hostname, platform, and Node version.
 *
 * A small discovery tool the agent can call to understand the
 * environment it's running in. No arguments, no side effects,
 * risk: 'safe'.
 */
import { z } from 'zod'
import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core'
import { hostname, userInfo, platform, arch } from 'node:os'

export const WhoamiInputSchema = z.object({})
export type WhoamiInput = z.infer<typeof WhoamiInputSchema>

export const WhoamiOutputSchema = z.object({
  /** OS username of the current process. */
  username: z.string(),
  /** Machine hostname. */
  hostname: z.string(),
  /** OS platform (e.g. 'darwin', 'linux', 'win32'). */
  platform: z.string(),
  /** CPU architecture (e.g. 'arm64', 'x64'). */
  arch: z.string(),
  /** Node.js version string (e.g. 'v20.14.0'). */
  nodeVersion: z.string(),
  /** Current working directory. */
  cwd: z.string(),
  /** Home directory of the current user. */
  home: z.string(),
})
export type WhoamiOutput = z.infer<typeof WhoamiOutputSchema>

export class WhoamiTool extends BaseTool {
  public readonly name = 'whoami'
  public readonly description =
    'Return information about the current user, host, platform, and Node.js version.'
  public readonly inputSchema: z.ZodType<unknown> = WhoamiInputSchema
  public readonly risk: ToolRisk = 'safe'
  public override readonly version = '0.1.0'

  protected async execute(_input: unknown, ctx: ToolContext): Promise<WhoamiOutput> {
    return {
      username: userInfo().username,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
      nodeVersion: process.version,
      cwd: ctx.cwd,
      home: userInfo().homedir,
    }
  }
}
