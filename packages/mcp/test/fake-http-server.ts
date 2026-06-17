/**
 * Fake MCP-over-HTTP server for tests.
 *
 * We don't want to depend on a real third-party MCP server (most are
 * remote, require API keys, or are flaky in CI). Instead we spin up
 * a minimal HTTP server on 127.0.0.1 that speaks just enough of the
 * MCP 2025-03-26 Streamable HTTP protocol to exercise the transport.
 *
 * Two response modes:
 *   - `mode: 'json'` — replies with `Content-Type: application/json`
 *     containing a single JSON-RPC envelope
 *   - `mode: 'sse'` — replies with `Content-Type: text/event-stream`
 *     and sends one or more `event: message` SSE events
 *
 * Tests can inspect the captured request bodies/headers and steer
 * the response (e.g. fail with 500) by mutating `serverState`.
 */

import { once } from 'node:events'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export type ResponseMode = 'json' | 'sse'

export interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
}

export interface FakeMcpHttpOptions {
  /** Default response mode for the server. */
  mode?: ResponseMode
  /**
   * The session id the server "assigns" on the first response.
   * Set to undefined to skip session assignment. The client
   * should echo this header on subsequent requests.
   */
  sessionId?: string
}

export interface FakeMcpHttp {
  url: string
  port: number
  mode: ResponseMode
  setMode: (mode: ResponseMode) => void
  setSessionId: (id: string | undefined) => void
  /**
   * Set a per-request override: when the test sends a request with
   * a matching `method` in `pendingOverride`, the server will use
   * that response builder instead of the default. Useful for
   * "fail this call, succeed the next" scenarios.
   */
  setOverride: (method: string | undefined, builder: ResponseBuilder | undefined) => void
  requests: CapturedRequest[]
  close: () => Promise<void>
}

export type ResponseBuilder = (req: CapturedRequest) => unknown

const sendJson = (
  res: ServerResponse,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  res.end(JSON.stringify(body))
}

const sendSse = async (
  res: ServerResponse,
  events: Array<{ event?: string; data: string }>,
  extraHeaders: Record<string, string> = {},
) => {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v)
  for (const evt of events) {
    if (evt.event) res.write(`event: ${evt.event}\n`)
    res.write(`data: ${evt.data}\n\n`)
  }
  res.end()
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf-8')
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export const startFakeMcpHttp = async (options: FakeMcpHttpOptions = {}): Promise<FakeMcpHttp> => {
  const state = {
    mode: options.mode ?? 'json',
    sessionId: options.sessionId,
    override: undefined as { method: string; builder: ResponseBuilder } | undefined,
  }

  const requests: CapturedRequest[] = []

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'DELETE') {
      // Session cleanup. Always 204 if we had a session, 405 if not.
      res.statusCode = state.sessionId ? 204 : 405
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end()
      return
    }
    const body = await readBody(req)
    const captured: CapturedRequest = {
      method: req.method ?? 'POST',
      url: req.url ?? '/',
      headers: req.headers,
      body,
    }
    requests.push(captured)

    const rpc = body as { method?: string } | undefined
    const extraHeaders: Record<string, string> = {}
    if (state.sessionId) extraHeaders['Mcp-Session-Id'] = state.sessionId

    if (state.override && rpc?.method === state.override.method) {
      const built = state.override.builder(captured)
      if (state.mode === 'sse') {
        const data = JSON.stringify(built)
        await sendSse(res, [{ event: 'message', data }], extraHeaders)
      } else {
        await sendJson(res, built, 200, extraHeaders)
      }
      return
    }

    // Default: echo a successful response. The test gets to
    // assert against the captured `body` and the response is
    // well-formed for `client.send(...)` to dispatch.
    if (!rpc || typeof rpc.method !== 'string') {
      sendJson(
        res,
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'no method' } },
        200,
        extraHeaders,
      )
      return
    }
    const id = (rpc as { id?: unknown }).id
    const result: Record<string, unknown> = {}
    if (rpc.method === 'initialize') {
      result.protocolVersion = '2025-03-26'
      result.capabilities = { tools: {} }
      result.serverInfo = { name: 'fake-http-server', version: '1.0.0' }
    } else if (rpc.method === 'tools/list') {
      result.tools = [
        {
          name: 'echo',
          description: 'Echo input',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ]
    } else if (rpc.method === 'tools/call') {
      const params = (rpc as { params?: { arguments?: { text?: string } } }).params
      result.content = [{ type: 'text', text: params?.arguments?.text ?? '' }]
    }
    const response = { jsonrpc: '2.0', id, result }
    if (state.mode === 'sse') {
      await sendSse(res, [{ event: 'message', data: JSON.stringify(response) }], extraHeaders)
    } else {
      sendJson(res, response, 200, extraHeaders)
    }
  }

  const server: Server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const addr = server.address() as AddressInfo
  const url = `http://127.0.0.1:${addr.port}/mcp`

  return {
    url,
    port: addr.port,
    get mode() {
      return state.mode
    },
    setMode: (mode) => {
      state.mode = mode
    },
    setSessionId: (id) => {
      state.sessionId = id
    },
    setOverride: (method, builder) => {
      state.override = method && builder ? { method, builder } : undefined
    },
    requests,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}
