/**
 * HTTP MCP transport.
 *
 * Implements the Streamable HTTP transport defined in MCP 2025-03-26.
 *
 * Wire shape:
 *   - Client POSTs a JSON-RPC envelope to the configured URL.
 *   - Server replies with EITHER:
 *       Content-Type: application/json  — the JSON-RPC response in the body
 *       Content-Type: text/event-stream — one or more SSE events; the
 *         response with the matching `id` is the one we wait for
 *   - The server MAY assign a session via the `Mcp-Session-Id` header
 *     on its first response. We echo that header on every subsequent
 *     request and DELETE the endpoint on close to clean up server-side
 *     state.
 *
 * We intentionally do NOT implement the legacy HTTP+SSE transport
 * (deprecated by the 2025-03-26 spec) — every modern MCP server speaks
 * the Streamable variant.
 *
 * Auth: callers may pass `apiKey` (added as a Bearer token) and/or
 * `headers` (raw extra headers, merged on top). The first form covers
 * the common case; the second lets users plug in custom auth schemes
 * (mTLS-issued tokens, custom header names, etc.) without us having
 * to special-case them.
 */

import {
  McpTransport,
  McpTransportError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type McpTransportOptions,
} from './base.js'

export interface HttpMcpTransportOptions extends McpTransportOptions {
  /**
   * The MCP server endpoint (must be a URL the local fetch can reach).
   * Typically `https://mcp.example.com/mcp`.
   */
  url: string
  /**
   * Bearer token. When set, every request gets
   * `Authorization: Bearer <apiKey>`. Ignored if `headers` already
   * contains an `Authorization` entry.
   */
  apiKey?: string
  /**
   * Custom headers (e.g. `X-Tenant-Id`, `X-Trace-Id`). Merged on top
   * of the defaults set by the transport. `Authorization` here wins
   * over `apiKey` if both are set.
   */
  headers?: Readonly<Record<string, string>>
  /**
   * Override the global `fetch`. Useful for tests (e.g. a wrapper
   * that injects delays) and for environments where users want
   * to add a custom agent.
   */
  fetchImpl?: typeof fetch
}

/**
 * Parse a single SSE event from a chunk of text. Returns the parsed
 * event and the number of characters consumed (so the caller can
 * stream-parse without re-scanning already-consumed data).
 *
 * SSE wire shape (per the WHATWG spec):
 *
 *   event: <name>\n
 *   id: <id>\n
 *   data: <text>\n
 *   \n                       <- blank line terminates the event
 *
 * Multiple `data:` lines are joined with `\n`. We only care about
 * `data` and `event` for MCP — `id` is for resumability which we
 * do not implement in this transport.
 */
export const parseSseEvent = (chunk: string): { event: string | null; data: string; consumed: number } | null => {
  // Find the first blank line — everything up to (but not including)
  // it is one event.
  const boundary = chunk.indexOf('\n\n')
  if (boundary === -1) return null
  const block = chunk.slice(0, boundary)
  const lines = block.split('\n')
  let event: string | null = null
  const dataParts: string[] = []
  for (const line of lines) {
    if (line.startsWith(':')) continue // comment, ignore
    const colon = line.indexOf(':')
    if (colon === -1) continue // malformed, skip
    const field = line.slice(0, colon)
    let value = line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataParts.push(value)
  }
  if (dataParts.length === 0) return null
  return {
    event,
    data: dataParts.join('\n'),
    // +2 to skip the trailing blank line.
    consumed: boundary + 2,
  }
}

/**
 * MCP transport backed by a single HTTP(S) endpoint.
 *
 * Stateless across requests: each call POSTs the JSON-RPC envelope
 * and reads the response. The only persistent state is the optional
 * `Mcp-Session-Id` captured from the server's first response and
 * echoed on every subsequent request.
 */
export class HttpMcpTransport extends McpTransport {
  public readonly url: string
  public readonly apiKey?: string
  public readonly customHeaders: Readonly<Record<string, string>>
  private readonly fetchImpl: typeof fetch
  private sessionId?: string
  private requestAbort?: AbortController

  constructor(options: HttpMcpTransportOptions) {
    super(options)
    this.url = options.url
    this.apiKey = options.apiKey
    this.customHeaders = options.headers ?? {}
    // Resolve the fetch implementation up-front so we can give a
    // useful error if the runtime has no built-in fetch (rare,
    // but possible on stripped-down Node distributions). Doing
    // this BEFORE the bind also avoids the cryptic
    // "Cannot read properties of undefined (reading 'bind')" that
    // we'd otherwise throw.
    const resolved = options.fetchImpl ?? globalThis.fetch
    if (typeof resolved !== 'function') {
      throw new McpTransportError(
        'HttpMcpTransport requires a global fetch; pass `fetchImpl` if you target a runtime without one',
      )
    }
    this.fetchImpl = resolved.bind(globalThis) as typeof fetch
  }

  public get name(): string {
    return `http:${this.url}`
  }

  /**
   * HTTP is connectionless from our side; nothing to open.
   *
   * The MCP `initialize` exchange is what actually validates that
   * the server is reachable — we don't probe ahead of time.
   */
  public async open(): Promise<void> {
    if (this._connected) return
    this._connected = true
  }

  /**
   * If we negotiated a session, tell the server to clean it up.
   * Best-effort: a failed DELETE is swallowed (the server may
   * already have GC'd the session, or the network may be down —
   * either way there's nothing we can do).
   */
  public async close(): Promise<void> {
    this._connected = false
    this.rejectAllPending(new McpTransportError('MCP http transport closed'))
    // Cancel any in-flight request so a stuck SSE stream doesn't
    // hold the process open.
    this.requestAbort?.abort()
    this.requestAbort = undefined
    if (this.sessionId) {
      const sid = this.sessionId
      this.sessionId = undefined
      try {
        await this.fetchImpl(this.url, {
          method: 'DELETE',
          headers: { 'Mcp-Session-Id': sid, ...this.baseHeaders() },
          signal: AbortSignal.timeout(5_000),
        })
      } catch {
        // Best-effort cleanup; the spec says the server MAY return
        // 405 if it doesn't support DELETE, which is also fine.
      }
    }
  }

  protected async sendRaw(request: JsonRpcRequest | JsonRpcNotification): Promise<void> {
    if (!this._connected) {
      throw new McpTransportError('MCP http transport is not open')
    }
    // Use a per-request AbortController so close() can cancel
    // a stuck stream mid-flight.
    const controller = new AbortController()
    this.requestAbort?.abort()
    this.requestAbort = controller
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

    let response: Response
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
          ...this.baseHeaders(),
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      this.requestAbort = undefined
      throw new McpTransportError(
        `MCP http request failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }

    clearTimeout(timeout)
    this.requestAbort = undefined

    if (!response.ok) {
      // Drain the body so the connection can be reused (fetch will
      // keep the underlying socket alive until the body is consumed).
      try {
        await response.text()
      } catch {
        // best effort
      }
      throw new McpTransportError(
        `MCP http server returned ${response.status} ${response.statusText}`,
      )
    }

    // Capture the session id if the server just assigned one. Per
    // the spec, the server may assign on ANY response — but in
    // practice it's always the first one. Capturing on every
    // response is safe (idempotent) and tolerates servers that
    // re-issue the header.
    const serverSession = response.headers.get('mcp-session-id')
    if (serverSession) this.sessionId = serverSession

    const contentType = response.headers.get('content-type') ?? ''

    if (contentType.includes('application/json')) {
      // Common case: the server replies with a single JSON envelope.
      let body: unknown
      try {
        body = await response.json()
      } catch (err) {
        throw new McpTransportError(
          `MCP http response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }
      this.dispatchIncoming(body)
      return
    }

    if (contentType.includes('text/event-stream')) {
      // Streaming case: read SSE events until the one with our
      // request id arrives, then close the stream.
      const requestId = 'id' in request ? request.id : undefined
      await this.consumeSseUntilResponse(response, requestId)
      return
    }

    // Unknown content-type: server is misbehaving.
    throw new McpTransportError(
      `MCP http server replied with unsupported Content-Type: ${contentType || '(empty)'}`,
    )
  }

  /**
   * Compute the headers we add to every request:
   *   - `apiKey` → `Authorization: Bearer ...` (unless caller already
   *     set Authorization in `headers`)
   *   - `headers` → merged on top
   */
  private baseHeaders(): Record<string, string> {
    const out: Record<string, string> = {}
    if (this.apiKey && !this.hasAuthHeader()) {
      out['Authorization'] = `Bearer ${this.apiKey}`
    }
    return { ...out, ...this.customHeaders }
  }

  private hasAuthHeader(): boolean {
    for (const key of Object.keys(this.customHeaders)) {
      if (key.toLowerCase() === 'authorization') return true
    }
    return false
  }

  /**
   * Stream the response body as SSE and dispatch events. Returns
   * when we see the response with the matching request id (for
   * request/response calls) or after we see a notification (no
   * id to match). Other events are ignored.
   */
  private async consumeSseUntilResponse(response: Response, requestId: string | number | undefined): Promise<void> {
    if (!response.body) {
      throw new McpTransportError('MCP http SSE response had no body')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let sawOurResponse = false
    try {
      while (!sawOurResponse) {
        const { value, done } = await reader.read()
        if (done) {
          if (requestId !== undefined) {
            throw new McpTransportError(
              `MCP http SSE stream ended before response id=${String(requestId)} arrived`,
            )
          }
          return
        }
        buffer += decoder.decode(value, { stream: true })
        // Drain as many complete events as the buffer holds.
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const event = parseSseEvent(buffer)
          if (!event) break
          buffer = buffer.slice(event.consumed)
          let parsed: unknown
          try {
            parsed = JSON.parse(event.data)
          } catch {
            // Non-JSON SSE event — ignore. The MCP spec only
            // mandates the `data` line; events like heartbeats
            // or comments may exist.
            continue
          }
          // If the event is the one we asked for, dispatch and
          // we're done. Otherwise, leave the stream open — there
          // may be more responses (notifications or our own).
          const responseObj = parsed as { id?: string | number }
          if (requestId === undefined) {
            // No request id (notification); we don't wait for
            // a specific response. The caller will treat the
            // notification as fire-and-forget.
            this.dispatchIncoming(parsed)
            return
          }
          if (responseObj.id === requestId) {
            this.dispatchIncoming(parsed)
            sawOurResponse = true
            break
          }
          // Not ours — could be a server-pushed notification.
          // Dispatch and keep reading.
          this.dispatchIncoming(parsed)
        }
      }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // best effort
      }
    }
  }
}
