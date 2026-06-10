/**
 * `gh` — curated GitHub CLI bridge.
 *
 * Wraps a small, audited subset of `gh` operations. The tool
 * deliberately does NOT expose `gh pr merge`, `gh repo delete`,
 * or any other destructive operations — the same principle as
 * the `git` tool. Each operation has a risk classification
 * ('safe' or 'approval-required') checked at runtime.
 *
 * Operations shipped:
 *   - pr_create  — `gh pr create` (approval-required)
 *   - pr_list    — `gh pr list` (safe)
 *   - pr_view    — `gh pr view` (safe)
 *   - pr_status  — `gh pr status` (safe)
 *   - issue_create — `gh issue create` (approval-required)
 *   - issue_list   — `gh issue list` (safe)
 *
 * `gh pr merge`, `gh pr close`, `gh repo delete`, `gh secret set`
 * etc. are deliberately absent.
 */
import { z } from 'zod'
import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core'

const GhOpSchema = z.enum([
  'pr_create',
  'pr_list',
  'pr_view',
  'pr_status',
  'issue_create',
  'issue_list',
])
export type GhOp = z.infer<typeof GhOpSchema>

export const GhInputSchema = z.object({
  op: GhOpSchema,
  /** PR/issue title (for create ops). */
  title: z.string().min(1).max(256).optional(),
  /** PR/issue body (for create ops). */
  body: z.string().max(65536).optional(),
  /** Base branch for PR creation. Defaults to the repo default. */
  base: z.string().min(1).max(256).optional(),
  /** Head branch for PR creation. Defaults to the current branch. */
  head: z.string().min(1).max(256).optional(),
  /** PR/issue number for view ops. */
  number: z.number().int().positive().optional(),
  /** Label(s) to apply (comma-separated). */
  labels: z.string().max(1024).optional(),
  /** Assignee(s) (comma-separated). */
  assignees: z.string().max(1024).optional(),
  /** Max items for list ops. Defaults to 20. */
  limit: z.number().int().min(1).max(100).optional(),
  /** State filter for list ops (open, closed, merged, all). */
  state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
  /** Max output bytes. Defaults to 256 KiB. */
  maxBytes: z.number().int().min(1024).max(5 * 1024 * 1024).optional(),
})

export type GhInput = z.infer<typeof GhInputSchema>

export const GhOutputSchema = z.object({
  op: GhOpSchema,
  /** Structured data (PR URL, number, etc.). */
  data: z.unknown(),
  /** Raw combined stdout+stderr. */
  raw: z.string(),
  exitCode: z.number().int().nullable(),
})
export type GhOutput = z.infer<typeof GhOutputSchema>

const OP_RISK: Record<GhOp, 'safe' | 'approval-required'> = {
  pr_create: 'approval-required',
  pr_list: 'safe',
  pr_view: 'safe',
  pr_status: 'safe',
  issue_create: 'approval-required',
  issue_list: 'safe',
}

export class GhTool extends BaseTool {
  public readonly name = 'gh'
  public readonly description =
    'Run a whitelisted GitHub CLI operation. Operations: pr_create, pr_list, pr_view, pr_status, issue_create, issue_list. ' +
    'Returns structured data plus raw output. Destructive operations (merge, close, delete) are intentionally not exposed.'
  public readonly inputSchema: z.ZodType<unknown> = GhInputSchema
  public readonly risk: ToolRisk = 'approval-required'
  public override readonly version = '0.1.0'

  public readonly maxOutputBytes: number = 256 * 1024

  protected async execute(input: unknown, ctx: ToolContext): Promise<GhOutput> {
    const parsed = input as GhInput
    const argv = this.argvFor(parsed)
    const maxBytes = parsed.maxBytes ?? this.maxOutputBytes

    const { spawn } = await import('node:child_process')
    const execArgv = ['gh', ...argv]
    const cwd = ctx.cwd

    return new Promise((resolve) => {
      const child = spawn(execArgv[0]!, execArgv.slice(1), {
        cwd,
        env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: ctx.signal,
      })

      // Write body via stdin for create ops.
      if (parsed.body && (parsed.op === 'pr_create' || parsed.op === 'issue_create')) {
        child.stdin?.write(parsed.body)
        child.stdin?.end()
      } else {
        child.stdin?.end()
      }

      const out: Buffer[] = []
      const err: Buffer[] = []
      let truncated = false

      const onData = (chunk: Buffer, sink: Buffer[]): void => {
        sink.push(chunk)
        const total = sink.reduce((n, b) => n + b.length, 0)
        if (total > maxBytes) {
          truncated = true
          child.kill('SIGTERM')
        }
      }
      child.stdout?.on('data', (b: Buffer) => onData(b, out))
      child.stderr?.on('data', (b: Buffer) => onData(b, err))

      child.on('exit', (code) => {
        const stdout = Buffer.concat(out).toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        const raw = (stdout + (stderr ? '\n' + stderr : '')).trim()
        resolve({
          op: parsed.op,
          data: { truncated, ...this.parseOutput(parsed.op, stdout) },
          raw,
          exitCode: code,
        })
      })
      child.on('error', () => {
        resolve({
          op: parsed.op,
          data: { error: 'spawn failed' },
          raw: '',
          exitCode: 127,
        })
      })
    })
  }

  private argvFor(input: GhInput): string[] {
    switch (input.op) {
      case 'pr_create': {
        const args = ['pr', 'create']
        if (input.title) args.push('--title', input.title)
        if (input.base) args.push('--base', input.base)
        if (input.head) args.push('--head', input.head)
        if (input.labels) args.push('--label', input.labels)
        if (input.assignees) args.push('--assignee', input.assignees)
        // Body is sent via stdin, not --body, to avoid shell escaping.
        if (input.body) args.push('--body-file', '-')
        return args
      }
      case 'pr_list': {
        const args = ['pr', 'list']
        const limit = input.limit ?? 20
        args.push('--limit', String(limit))
        if (input.state) args.push('--state', input.state)
        if (input.labels) args.push('--label', input.labels)
        if (input.assignees) args.push('--assignee', input.assignees)
        args.push('--json', 'number,title,state,author,headRefName,baseRefName,url,createdAt')
        return args
      }
      case 'pr_view': {
        const args = ['pr', 'view']
        if (input.number) args.push(String(input.number))
        args.push('--json', 'number,title,state,body,author,headRefName,baseRefName,url,createdAt,mergedAt,additions,deletions,reviews,statusCheckRollup')
        return args
      }
      case 'pr_status': {
        return ['pr', 'status', '--json', 'number,title,state,reviewDecision,statusCheckRollup,url']
      }
      case 'issue_create': {
        const args = ['issue', 'create']
        if (input.title) args.push('--title', input.title)
        if (input.labels) args.push('--label', input.labels)
        if (input.assignees) args.push('--assignee', input.assignees)
        if (input.body) args.push('--body-file', '-')
        return args
      }
      case 'issue_list': {
        const args = ['issue', 'list']
        const limit = input.limit ?? 20
        args.push('--limit', String(limit))
        if (input.state) args.push('--state', input.state)
        if (input.labels) args.push('--label', input.labels)
        if (input.assignees) args.push('--assignee', input.assignees)
        args.push('--json', 'number,title,state,author,labels,url,createdAt')
        return args
      }
    }
  }

  private parseOutput(op: GhOp, stdout: string): Record<string, unknown> {
    // For JSON-output ops, try to parse the JSON so the agent gets
    // structured data. Fall back to raw text on parse failure.
    const jsonOps = new Set<GhOp>(['pr_list', 'pr_view', 'pr_status', 'issue_list'])
    if (jsonOps.has(op)) {
      try {
        return { result: JSON.parse(stdout) }
      } catch {
        return { raw: stdout }
      }
    }
    // pr_create / issue_create: extract the URL from stdout.
    const urlMatch = stdout.match(/https:\/\/github\.com\/\S+\/(pull|issues)\/\d+/)
    return urlMatch ? { url: urlMatch[0] } : { raw: stdout }
  }
}
