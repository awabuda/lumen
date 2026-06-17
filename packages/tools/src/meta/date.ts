import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core'
/**
 * `date` — current date/time in ISO 8601 format.
 *
 * A small, safe utility tool that the agent can call to anchor
 * its reasoning in real time. No arguments, no side effects,
 * risk: 'safe'.
 */
import { z } from 'zod'

export const DateInputSchema = z.object({})
export type DateInput = z.infer<typeof DateInputSchema>

export const DateOutputSchema = z.object({
  /** ISO 8601 timestamp with timezone offset (e.g. 2026-06-10T11:30:00+08:00). */
  iso: z.string(),
  /** Unix epoch in milliseconds. */
  epochMs: z.number(),
  /** UTC string (e.g. "Tue, 10 Jun 2026 03:30:00 GMT"). */
  utc: z.string(),
  /** IANA timezone name from the host (e.g. "Asia/Shanghai"). */
  timezone: z.string(),
})
export type DateOutput = z.infer<typeof DateOutputSchema>

export class DateTool extends BaseTool {
  public readonly name = 'date'
  public readonly description =
    'Get the current date and time in ISO 8601 format. Use this to anchor reasoning in real time.'
  public readonly inputSchema: z.ZodType<unknown> = DateInputSchema
  public readonly risk: ToolRisk = 'safe'
  public override readonly version = '0.1.0'

  protected async execute(_input: unknown, _ctx: ToolContext): Promise<DateOutput> {
    const now = new Date()
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return {
      iso: now.toISOString(),
      epochMs: now.getTime(),
      utc: now.toUTCString(),
      timezone,
    }
  }
}
