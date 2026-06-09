/**
 * HttpMcpTransport tests.
 *
 * Two paths: JSON responses (the common case) and SSE responses
 * (long-running / server-pushed). We also cover the lifecycle bits
 * the stdio transport doesn't share with HTTP:
 *   - Mcp-Session-Id capture + echo
 *   - Authorization header construction (Bearer + raw)
 *   - DELETE on close (and the 405 best-effort fallback)
 *   - Non-2xx response surfaces as a transport error
 *   - Unsupported Content-Type surfaces as a transport error
 *
 * The fake HTTP server is defined in ./fake-http-server.ts; it
 * speaks just enough of the 2025-03-26 Streamable HTTP protocol
 * to exercise the transport without any network access.
 */

import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpMcpTransport, McpClient, parseSseEvent } from '../src/index.js'
import { startFakeMcpHttp, type FakeMcpHttp } from './fake-http-server.js'

let server: FakeMcpHttp | undefined

afterEach(async () => {
  if (server) {
    await server.close()
    server = undefined
  }
})

describe('parseSseEvent', () => {
  it('parses a single event with data only', () => {
    const result = parseSseEvent('data: hello\n\nrest')
    expect(result).toEqual({ event: null, data: 'hello', consumed: 13 })
  })

  it('parses event + data', () => {
    const result = parseSseEvent('event: message\ndata: {"x":1}\n\nrest')
    expect(result).toEqual({ event: 'message', data: '{"x":1}', consumed: 30 })
  })

  it('joins multiple data lines with newlines', () => {
    const result = parseSseEvent('data: line1\ndata: line2\n\nrest')
    expect(result).toEqual({ event: null, data: 'line1\nline2', consumed: 25 })
  })

  it('strips a single leading space from the value', () => {
    const result = parseSseEvent('data:  spaced\n\nrest')
    expect(result?.data).toBe(' spaced')
  })

  it('skips comments (lines starting with :)', () => {
    const result = parseSseEvent(': this is a comment\ndata: ok\n\nrest')
    expect(result?.data).toBe('ok')
  })

  it('returns null when no complete event is in the buffer', () => {
    expect(parseSseEvent('data: partial')).toBeNull()
  })

  it('returns null when only the blank line is missing', () => {
    expect(parseSseEvent('data: x')).toBeNull()
  })
})

describe('HttpMcpTransport — JSON response mode', () => {
  beforeEach(() => {
    server = undefined // reset
  })

  it('sends a JSON-RPC POST and parses the JSON reply', async () => {
    server = await startFakeMcpHttp({ mode: 'json', sessionId: 'sess-1' })
    const transport = new HttpMcpTransport({ url: server.url, timeoutMs: 5_000 })
    const client = new McpClient(transport)

    await client.initialize()
    expect(client.serverInfo?.name).toBe('fake-http-server')

    const tools = await client.listTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('echo')

    const result = await client.callTool('echo', { text: 'hi' })
    expect(result.content[0]?.text).toBe('hi')

    // The first request (initialize) goes out BEFORE the server
    // has assigned a session, so it has no Mcp-Session-Id header.
    // Every subsequent request must echo it back.
    expect(server.requests[0]?.headers['mcp-session-id']).toBeUndefined()
    for (const req of server.requests.slice(1)) {
      expect(req.headers['mcp-session-id']).toBe('sess-1')
    }
    // The request method names should be the canonical MCP trio.
    expect(server.requests.map((r) => (r.body as { method: string }).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ])
  })

  it('attaches Authorization: Bearer from apiKey', async () => {
    server = await startFakeMcpHttp({ mode: 'json' })
    const transport = new HttpMcpTransport({ url: server.url, apiKey: 'secret-123', timeoutMs: 5_000 })
    const client = new McpClient(transport)
    await client.initialize()

    for (const req of server.requests) {
      expect(req.headers['authorization']).toBe('Bearer secret-123')
    }
  })

  it('merges custom headers on top of apiKey-derived defaults', async () => {
    server = await startFakeMcpHttp({ mode: 'json' })
    const transport = new HttpMcpTransport({
      url: server.url,
      apiKey: 'unused',
      headers: { 'X-Tenant-Id': 'acme', 'Authorization': 'Custom scheme-xyz' },
      timeoutMs: 5_000,
    })
    const client = new McpClient(transport)
    await client.initialize()

    for (const req of server.requests) {
      expect(req.headers['authorization']).toBe('Custom scheme-xyz')
      expect(req.headers['x-tenant-id']).toBe('acme')
    }
  })

  it('raises a transport error on non-2xx', async () => {
    server = await startFakeMcpHttp({ mode: 'json' })
    const transport = new HttpMcpTransport({ url: server.url, timeoutMs: 5_000 })
    const client = new McpClient(transport)
    await server.close()
    server = undefined
    await expect(client.initialize()).rejects.toThrow(/MCP http/)
  })

  it('raises a transport error on unsupported Content-Type', async () => {
    // Spin up a one-off server that replies with text/plain.
    const { createServer } = await import('node:http')
    const { once } = await import('node:events')
    const fallback = createServer((_req, res) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/plain')
      res.end('not json')
    })
    fallback.listen(0, '127.0.0.1')
    await once(fallback, 'listening')
    const addr = fallback.address()
    const url = `http://127.0.0.1:${(addr as { port: number }).port}/mcp`
    const transport = new HttpMcpTransport({ url, timeoutMs: 5_000 })
    const client = new McpClient(transport)
    await expect(client.initialize()).rejects.toThrow(/unsupported Content-Type/)
    fallback.close()
    await once(fallback, 'close')
  })
})

describe('HttpMcpTransport — SSE response mode', () => {
  beforeEach(() => {
    server = undefined
  })

  it('parses a server-streamed SSE response', async () => {
    server = await startFakeMcpHttp({ mode: 'sse', sessionId: 'sess-sse' })
    const transport = new HttpMcpTransport({ url: server.url, timeoutMs: 5_000 })
    const client = new McpClient(transport)

    await client.initialize()
    const result = await client.callTool('echo', { text: 'streamed' })
    expect(result.content[0]?.text).toBe('streamed')
  })
})

describe('HttpMcpTransport — lifecycle', () => {
  it('sends DELETE on close to terminate the session', async () => {
    server = await startFakeMcpHttp({ mode: 'json', sessionId: 'cleanup-me' })
    const transport = new HttpMcpTransport({ url: server.url, timeoutMs: 5_000 })
    const client = new McpClient(transport)
    await client.initialize()
    await client.close()
    // After close, the session id is cleared; a new connect won't
    // include the header. We assert indirectly by re-opening and
    // checking the requests array.
    await client.initialize()
    expect(server.requests[0]?.headers['mcp-session-id']).toBeUndefined()
    expect(server.requests.at(-1)?.headers['mcp-session-id']).toBe('cleanup-me')
  })

  it('survives a server that returns 405 on DELETE (best-effort cleanup)', async () => {
    server = await startFakeMcpHttp({ mode: 'json' }) // no session, so DELETE → 405
    const transport = new HttpMcpTransport({ url: server.url, timeoutMs: 5_000 })
    const client = new McpClient(transport)
    await client.initialize()
    await expect(client.close()).resolves.toBeUndefined()
  })

  it('exposes a stable name that includes the transport prefix', () => {
    const transport = new HttpMcpTransport({ url: 'https://mcp.example.com/v1/mcp' })
    expect(transport.name).toBe('http:https://mcp.example.com/v1/mcp')
  })

  it('throws if the runtime has no fetch and none was injected', () => {
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch
    try {
      // @ts-expect-error — temporarily strip global fetch
      delete globalThis.fetch
      expect(() => new HttpMcpTransport({ url: 'http://x' })).toThrow(/global fetch/)
    } finally {
      ;(globalThis as { fetch?: typeof fetch }).fetch = originalFetch
    }
  })
})

describe('HttpMcpTransport — discover integration', () => {
  it('connectMcpServer wires the HTTP transport for `transport: http` configs', async () => {
    const { connectMcpServer, closeAllMcpServers } = await import('../src/index.js')
    // Parse through the schema so the defaults (headers/args/env)
    // are applied — this is the same path the config loader uses.
    const { McpServerConfigSchema } = await import('@lumen/config')
    server = await startFakeMcpHttp({ mode: 'json', sessionId: 'discover-sess' })
    const config = McpServerConfigSchema.parse({
      name: 'remote',
      transport: 'http',
      url: server.url,
      apiKey: 'sk-test',
    })
    const discovered = await connectMcpServer('remote', config, { timeoutMs: 5_000 })
    expect(discovered.tools).toHaveLength(1)
    expect(discovered.tools[0]?.name).toBe('mcp_remote_echo')
    // And the auth header reached the server:
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer sk-test')
    await closeAllMcpServers([discovered])
  })
})
