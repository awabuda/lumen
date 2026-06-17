/**
 * Base contracts for MCP transport and client.
 *
 * MCP (Model Context Protocol) uses JSON-RPC 2.0 over pluggable transports.
 * Each transport strategy implements the {@link McpTransport} interface.
 * The {@link McpClient} composes a transport and exposes the MCP lifecycle.
 *
 * Design follows the Lumen "inheritable, pluggable, independently runnable"
 * pattern: strategy interface for transports, abstract class for the client,
 * factory registry for late-bound strategy selection.
 */

import { type ToolDescriptor, ToolError } from '@lumen/core'

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 message types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// MCP protocol methods (subset we support)
// ---------------------------------------------------------------------------

export interface McpInitializeRequest {
  protocolVersion: string
  capabilities: Record<string, unknown>
  clientInfo: { name: string; version: string }
}

export interface McpInitializeResult {
  protocolVersion: string
  capabilities: Record<string, unknown>
  serverInfo: { name: string; version: string }
}

export interface McpTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpListToolsResult {
  tools: McpTool[]
  nextCursor?: string
}

export interface McpCallToolParams {
  name: string
  arguments?: Record<string, unknown>
}

export interface McpCallToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

// ---------------------------------------------------------------------------
// Transport strategy
// ---------------------------------------------------------------------------

export interface McpTransportOptions {
  /** Per-tool-call timeout in ms. */
  timeoutMs?: number
  /** Initial connect timeout in ms. */
  connectTimeoutMs?: number
}

/**
 * Strategy interface for MCP transport.
 *
 * A transport owns a single JSON-RPC connection to one MCP server.
 * It handles framing, request/response matching, reconnection, and
 * lifecycle (open → message exchange → close).
 *
 * Subclasses override {@link sendRaw} and {@link recvRaw} for the
 * actual I/O (stdio pipes, HTTP streams, WebSocket, etc.).
 */
export abstract class McpTransport {
  protected requestId = 0
  protected pending = new Map<
    string | number,
    {
      resolve: (res: unknown) => void
      reject: (err: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  protected _connected = false

  public abstract get name(): string
  public get connected(): boolean {
    return this._connected
  }

  /**
   * Open the transport. Must be called before {@link send}.
   * Throws on failure.
   */
  public abstract open(): Promise<void>

  /**
   * Close the transport cleanly. Rejects all pending requests.
   */
  public abstract close(): Promise<void>

  /**
   * Send a JSON-RPC request and await the response.
   */
  public async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new McpTransportError(`Request ${method} timed out`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.sendRaw(request).catch((err: unknown) => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /** Subclass hook: serialize and write a request to the wire. */
  protected abstract sendRaw(request: JsonRpcRequest | JsonRpcNotification): Promise<void>

  /** Subclass hook: parse and dispatch an incoming response to the pending map. */
  protected dispatchIncoming(raw: unknown): void {
    const response = raw as JsonRpcResponse
    if (!response || typeof response !== 'object' || response.jsonrpc !== '2.0') return
    const id = response.id
    if (id === undefined || id === null) return // notification, ignore
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    if (response.error) {
      pending.reject(
        new McpTransportError(`MCP error ${response.error.code}: ${response.error.message}`),
      )
    } else {
      pending.resolve(response.result)
    }
  }

  /** Resolve/reject all pending requests (used on close). */
  protected rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }

  protected timeoutMs: number
  protected connectTimeoutMs: number

  constructor(options: McpTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 120_000
    this.connectTimeoutMs = options.connectTimeoutMs ?? 60_000
  }
}

export class McpTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'McpTransportError'
  }
}

// ---------------------------------------------------------------------------
// MCP Client
// ---------------------------------------------------------------------------

export interface McpClientOptions extends McpTransportOptions {
  clientInfo?: { name: string; version: string }
}

/**
 * High-level MCP client built on a transport strategy.
 *
 * Handles the MCP lifecycle:
 * 1. `initialize` — negotiate protocol version + capabilities
 * 2. `listTools` — discover server tools
 * 3. `callTool` — invoke a tool
 * 4. `close` — terminate the session
 */
export class McpClient {
  public readonly transport: McpTransport
  public serverInfo?: { name: string; version: string }
  public serverCapabilities?: Record<string, unknown>
  private clientInfo: { name: string; version: string }
  private initialized = false

  constructor(transport: McpTransport, options: McpClientOptions = {}) {
    this.transport = transport
    this.clientInfo = options.clientInfo ?? { name: '@lumen/mcp', version: '0.1.0' }
  }

  get connected(): boolean {
    return this.transport.connected && this.initialized
  }

  /**
   * Open transport + send `initialize`. Must be called before
   * {@link listTools} or {@link callTool}.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return
    await this.transport.open()
    const result = (await this.transport.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: this.clientInfo,
    } satisfies McpInitializeRequest)) as McpInitializeResult | undefined
    if (!result) {
      throw new McpTransportError('Initialize returned no result')
    }
    this.serverInfo = result.serverInfo
    this.serverCapabilities = result.capabilities
    await this.transport.send('notifications/initialized')
    this.initialized = true
  }

  /**
   * List available tools from the server.
   */
  public async listTools(): Promise<McpTool[]> {
    if (!this.connected) {
      throw new McpTransportError('Client not initialized — call initialize() first')
    }
    const result = (await this.transport.send('tools/list')) as McpListToolsResult | undefined
    return result?.tools ?? []
  }

  /**
   * Call a tool on the server.
   */
  public async callTool(name: string, args?: Record<string, unknown>): Promise<McpCallToolResult> {
    if (!this.connected) {
      throw new McpTransportError('Client not initialized — call initialize() first')
    }
    const result = (await this.transport.send('tools/call', {
      name,
      arguments: args,
    } satisfies McpCallToolParams)) as McpCallToolResult | undefined
    if (!result) {
      throw new McpTransportError(`Tool "${name}" returned no result`)
    }
    return result
  }

  /**
   * Close the transport and reset state.
   */
  public async close(): Promise<void> {
    this.initialized = false
    this.serverInfo = undefined
    this.serverCapabilities = undefined
    await this.transport.close()
  }
}

// ---------------------------------------------------------------------------
// Tool proxy — wraps an MCP tool as a Lumen BaseTool
// ---------------------------------------------------------------------------

import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core'
import { z } from 'zod'

/**
 * Wrap a remote MCP tool as a local BaseTool so it can be registered
 * in a Lumen ToolRegistry and called by the agent loop.
 */
export class McpToolProxy extends BaseTool {
  public readonly name: string
  public readonly description: string
  public readonly inputSchema: z.ZodType<unknown>
  public readonly risk: ToolRisk = 'safe'
  private readonly client: McpClient

  constructor(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    client: McpClient,
  ) {
    super()
    this.name = name
    this.description = description
    this.client = client
    this.inputSchema = mcpSchemaToZod(inputSchema)
  }

  protected async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    const result = await this.client.callTool(
      this.name,
      input as Record<string, unknown> | undefined,
    )
    if (result.isError) {
      const text = result.content.map((c) => c.text ?? '').join('\n')
      throw new ToolError(`MCP tool "${this.name}" returned error: ${text}`, {
        toolName: this.name,
      })
    }
    return result.content.map((c) => c.text ?? c.data ?? '').join('\n')
  }
}

/**
 * Minimal MCP JSON Schema → Zod conversion.
 * Only handles the shapes MCP servers commonly emit.
 */
const mcpSchemaToZod = (schema: Record<string, unknown>): z.ZodType<unknown> => {
  if (!schema || typeof schema !== 'object') return z.any()
  const s = schema as {
    type?: string
    properties?: Record<string, unknown>
    items?: Record<string, unknown>
    required?: string[]
  }
  if (s.type === 'object' && s.properties) {
    const shape: Record<string, z.ZodType<unknown>> = {}
    const requiredSet = new Set<string>(s.required ?? [])
    for (const [key, val] of Object.entries(s.properties)) {
      const prop = val as Record<string, unknown>
      let field = mcpSchemaToZod(prop)
      if (!requiredSet.has(key)) field = field.optional()
      shape[key] = field
    }
    return z.object(shape)
  }
  if (s.type === 'string') return z.string()
  if (s.type === 'number' || s.type === 'integer') return z.number()
  if (s.type === 'boolean') return z.boolean()
  if (s.type === 'array' && s.items) return z.array(mcpSchemaToZod(s.items))
  if (Array.isArray(s.type)) {
    const variants = s.type.map((t: string) => mcpSchemaToZod({ type: t }))
    if (variants.length === 0) return z.any()
    if (variants.length === 1) return variants[0]!
    return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  return z.any()
}
