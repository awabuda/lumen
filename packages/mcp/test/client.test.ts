import { describe, expect, it } from 'vitest'
import { McpClient, McpToolProxy, McpTransport, type JsonRpcNotification, type JsonRpcRequest } from '../src/index.js'

class FakeTransport extends McpTransport {
  public readonly sent: Array<JsonRpcRequest | JsonRpcNotification> = []
  public get name(): string { return 'fake' }
  public async open(): Promise<void> { this._connected = true }
  public async close(): Promise<void> { this._connected = false }
  protected async sendRaw(request: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    this.sent.push(request)
    if ('id' in request && request.method === 'initialize') {
      this.dispatchIncoming({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-server', version: '1.0.0' },
        },
      })
    }
    if ('id' in request && request.method === 'notifications/initialized') {
      this.dispatchIncoming({ jsonrpc: '2.0', id: request.id, result: {} })
    }
    if ('id' in request && request.method === 'tools/list') {
      this.dispatchIncoming({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo input',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        },
      })
    }
    if ('id' in request && request.method === 'tools/call') {
      const params = request.params as { arguments?: { text?: string } }
      this.dispatchIncoming({
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: params.arguments?.text ?? '' }] },
      })
    }
  }
}

describe('McpClient', () => {
  it('initializes, lists tools, and calls a tool', async () => {
    const transport = new FakeTransport({ timeoutMs: 100 })
    const client = new McpClient(transport)

    await client.initialize()
    expect(client.connected).toBe(true)
    expect(client.serverInfo?.name).toBe('fake-server')

    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('echo')

    const result = await client.callTool('echo', { text: 'hello' })
    expect(result.content[0]?.text).toBe('hello')
  })

  it('wraps a remote tool as a BaseTool proxy', async () => {
    const transport = new FakeTransport({ timeoutMs: 100 })
    const client = new McpClient(transport)
    await client.initialize()

    const tool = new McpToolProxy(
      'echo',
      'Echo input',
      { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      client,
    )
    const output = await tool.call(
      { text: 'proxied' },
      { cwd: process.cwd(), signal: new AbortController().signal, sessionId: 'test' },
    )
    expect(output).toBe('proxied')
  })
})
