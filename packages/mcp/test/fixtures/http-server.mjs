#!/usr/bin/env node
/**
 * Fixture MCP-over-HTTP server.
 *
 * Spins up a tiny in-process HTTP server that speaks the
 * 2025-03-26 Streamable HTTP MCP protocol. Used by `lumen doctor`
 * round-trip checks and as a manual smoke test fixture.
 *
 * Usage:
 *   node packages/mcp/test/fixtures/http-server.mjs [port]
 *   # default port: 0 (pick a free one and print to stdout)
 *
 * On startup we print `READY <port>` so callers know when to
 * point their client at us. We then service MCP requests until
 * killed with SIGTERM/SIGINT.
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 0)

const send = (res, status, body, headers = {}) => {
  res.statusCode = status
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v)
  res.end(body)
}

const sendJson = (res, body, headers = {}) => {
  send(res, 200, JSON.stringify(body), { 'Content-Type': 'application/json', ...headers })
}

const sendSse = (res, body, headers = {}) => {
  res.statusCode = 200
  for (const [k, v] of Object.entries({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    ...headers,
  })) res.setHeader(k, v)
  res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
  res.end()
}

const server = createServer((req, res) => {
  if (req.method === 'DELETE') {
    send(res, 204, '')
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, 'method not allowed')
    return
  }
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let req2
    try {
      req2 = JSON.parse(body)
    } catch {
      sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      return
    }
    const id = req2.id
    const extraHeaders = { 'Mcp-Session-Id': 'fixture-http-session' }
    if (req2.method === 'initialize') {
      sendJson(res, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-http-mcp', version: '1.0.0' },
        },
      }, extraHeaders)
      return
    }
    if (req2.method === 'notifications/initialized') {
      sendJson(res, { jsonrpc: '2.0', id, result: {} }, extraHeaders)
      return
    }
    if (req2.method === 'tools/list') {
      sendJson(res, {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo text',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            },
          ],
        },
      }, extraHeaders)
      return
    }
    if (req2.method === 'tools/call') {
      sendJson(res, {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: req2.params?.arguments?.text ?? '' }] },
      }, extraHeaders)
      return
    }
    sendJson(res, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }, extraHeaders)
  })
})

server.listen(port, '127.0.0.1', () => {
  const addr = server.address()
  process.stdout.write(`READY ${addr.port}\n`)
})

process.on('SIGTERM', () => server.close(() => process.exit(0)))
process.on('SIGINT', () => server.close(() => process.exit(0)))
