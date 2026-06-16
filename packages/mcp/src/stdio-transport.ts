/**
 * Stdio MCP transport.
 *
 * Frames JSON-RPC messages as newline-delimited JSON over a child process'
 * stdin/stdout. This is the common transport for local MCP servers started
 * via `npx`, `uvx`, or a custom executable.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import {
  McpTransport,
  McpTransportError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type McpTransportOptions,
} from './base.js'

export interface StdioMcpTransportOptions extends McpTransportOptions {
  command: string
  args?: string[]
  env?: Readonly<Record<string, string>>
  cwd?: string
}

const SAFE_ENV_KEYS = new Set(['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'TMPDIR'])

/**
 * Build the child process environment for an MCP stdio server.
 *
 * We only inherit a small safe baseline plus any `XDG_*` variables and
 * explicit config env values, preventing accidental secret leakage into
 * untrusted local MCP servers.
 */
export const buildSafeMcpEnv = (
  source: NodeJS.ProcessEnv = process.env,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!value) continue
    if (SAFE_ENV_KEYS.has(key) || key.startsWith('XDG_')) out[key] = value
  }
  return { ...out, ...explicit }
}

/**
 * MCP transport backed by a long-lived child process.
 */
export class StdioMcpTransport extends McpTransport {
  public readonly command: string
  public readonly args: string[]
  public readonly env: Readonly<Record<string, string>>
  public readonly cwd?: string

  private child?: ChildProcessWithoutNullStreams
  private lineReader?: Interface

  constructor(options: StdioMcpTransportOptions) {
    super(options)
    this.command = options.command
    this.args = options.args ?? []
    this.env = options.env ?? {}
    this.cwd = options.cwd
  }

  public get name(): string {
    return `stdio:${this.command}`
  }

  public async open(): Promise<void> {
    if (this._connected) return
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: buildSafeMcpEnv(process.env, this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.lineReader = createInterface({ input: this.child.stdout })
    this.lineReader.on('line', (line) => {
      if (!line.trim()) return
      try {
        this.dispatchIncoming(JSON.parse(line) as unknown)
      } catch {
        // Non-JSON stdout from a broken server is ignored here; the stderr
        // stream and request timeout will surface a useful error to callers.
      }
    })

    this.child.once('error', (err) => {
      this._connected = false
      this.rejectAllPending(
        new McpTransportError(`MCP stdio process error: ${err.message}`, { cause: err }),
      )
    })
    this.child.once('exit', (code, signal) => {
      this._connected = false
      this.rejectAllPending(
        new McpTransportError(
          `MCP stdio process exited: code=${code ?? 'n/a'} signal=${signal ?? 'n/a'}`,
        ),
      )
    })

    this._connected = true
  }

  public async close(): Promise<void> {
    this._connected = false
    this.rejectAllPending(new McpTransportError('MCP stdio transport closed'))
    this.lineReader?.close()
    const child = this.child
    this.child = undefined
    if (child && !child.killed) {
      child.kill('SIGTERM')
    }
  }

  protected async sendRaw(request: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this.child || !this._connected) {
      throw new McpTransportError('MCP stdio transport is not open')
    }
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(`${JSON.stringify(request)}\n`, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
