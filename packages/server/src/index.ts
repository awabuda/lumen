/**
 * HTTP + WebSocket server adapter for the Lumen agent.
 *
 * Exposes a small JSON-over-HTTP API:
 *   POST /v1/agent/run      — start a run
 *   GET  /v1/agent/:id      — get run status
 *   POST /v1/agent/:id/cancel — cancel a run
 *   GET  /v1/health         — health check
 *
 * Plus a WebSocket endpoint for streaming events:
 *   WS  /v1/agent/:id/stream
 *
 * Why a separate package:
 *   The CLI, the web dashboard, and the desktop client all
 *   need a way to drive the agent over the network. This
 *   adapter is the single source of truth for that protocol.
 *
 * The transport is pluggable via {@link BaseServerAdapter};
 * Node's http module ships as {@link NodeHttpAdapter}, and
 * custom adapters can wrap Fastify/Express/etc.
 */

import { z } from 'zod'

import type { Agent, AgentRunResult, RunEvent } from '@lumen/core'

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** A request to start an agent run. */
export interface RunRequest {
  readonly userMessage: string
  readonly sessionId?: string
  readonly maxIterations?: number
}

/** Zod schema for {@link RunRequest}. */
export const RunRequestSchema = z.object({
  userMessage: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  maxIterations: z.number().int().positive().optional(),
})

/** The HTTP response shape for a run. */
export type RunResponse = AgentRunResult | { error: string }

/** Stable identifier for an active run. */
export interface ActiveRun {
  readonly id: string
  readonly agent: Agent
  readonly abortController: AbortController
  readonly startedAt: number
}

// ---------------------------------------------------------------------------
// RunRegistry — in-memory tracking of active runs
// ---------------------------------------------------------------------------

/** Tracks in-flight runs by id. */
export class RunRegistry {
  private readonly runs: Map<string, ActiveRun> = new Map()

  /** Register a new run. Returns the generated id. */
  public register(agent: Agent, abortController: AbortController): string {
    const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.runs.set(id, {
      id,
      agent,
      abortController,
      startedAt: Date.now(),
    })
    return id
  }

  /** Get an active run by id. */
  public get(id: string): ActiveRun | undefined {
    return this.runs.get(id)
  }

  /** Mark a run as finished (idempotent). */
  public finish(id: string): void {
    this.runs.delete(id)
  }

  /** Cancel a run by id. */
  public cancel(id: string): boolean {
    const run = this.runs.get(id)
    if (!run) return false
    run.abortController.abort()
    return true
  }

  /** Number of active runs. */
  public get size(): number {
    return this.runs.size
  }

  /** All active run ids. */
  public ids(): ReadonlyArray<string> {
    return [...this.runs.keys()]
  }
}

// ---------------------------------------------------------------------------
// BaseServerAdapter
// ---------------------------------------------------------------------------

/** The contract every server adapter fulfills. */
export abstract class BaseServerAdapter {
  /** Stable identifier. */
  public abstract readonly id: string

  /** Start the server and begin accepting connections. */
  public abstract start(): Promise<void>
  /** Stop the server. */
  public abstract stop(): Promise<void>
  /** Port the server is listening on. */
  public abstract get port(): number
  /** Whether the server is currently listening. */
  public abstract get isRunning(): boolean
}

// ---------------------------------------------------------------------------
// NodeHttpAdapter — uses Node's built-in http + ws
// ---------------------------------------------------------------------------

/** Options for {@link NodeHttpAdapter}. */
export const NodeHttpAdapterOptionsSchema = z.object({
  /** Port to listen on. 0 picks a random free port. */
  port: z.number().int().nonnegative().default(0),
  /** Host to bind to. */
  host: z.string().default('127.0.0.1'),
  /** Path prefix for all routes. */
  pathPrefix: z.string().default('/v1'),
})

/** Options for {@link NodeHttpAdapter}. */
export type NodeHttpAdapterOptions = z.input<typeof NodeHttpAdapterOptionsSchema>

/**
 * The default server adapter: Node's built-in `http` module
 * with hand-rolled routing and a `ws` upgrade for streaming.
 *
 * This intentionally avoids Express/Fastify to keep the
 * dependency footprint minimal. The protocol is simple
 * enough that hand-rolled routing is clearer than a framework.
 */
export class NodeHttpAdapter extends BaseServerAdapter {
  public readonly id = 'node-http'
  private readonly options: z.infer<typeof NodeHttpAdapterOptionsSchema>
  private readonly registry: RunRegistry
  private server: import('http').Server | undefined
  private _port = 0
  private _running = false

  public constructor(
    registry: RunRegistry = new RunRegistry(),
    options: NodeHttpAdapterOptions = {},
  ) {
    super()
    this.registry = registry
    this.options = NodeHttpAdapterOptionsSchema.parse(options)
  }

  public get port(): number {
    return this._port
  }

  public get isRunning(): boolean {
    return this._running
  }

  public async start(): Promise<void> {
    if (this._running) return
    const { createServer } = await import('node:http')
    const { WebSocketServer } = await import('ws')

    const server = createServer((req, res) => {
      void this.handleHttp(req, res)
    })

    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const prefix = this.options.pathPrefix
      const match = url.pathname.match(new RegExp(`^${prefix}/agent/([^/]+)/stream$`))
      if (!match) {
        socket.destroy()
        return
      }
      const runId = match[1]
      if (!runId) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.handleWs(ws, runId)
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, this.options.host, () => resolve())
    })

    const addr = server.address()
    if (addr && typeof addr === 'object') this._port = addr.port

    this.server = server
    this._running = true
  }

  public async stop(): Promise<void> {
    if (!this._running || !this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this._running = false
    this.server = undefined
  }

  // -------------------------------------------------------------------------
  // HTTP routing
  // -------------------------------------------------------------------------

  private async handleHttp(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const prefix = this.options.pathPrefix
    const send = (status: number, body: unknown): void => {
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === `${prefix}/health`) {
      send(200, { status: 'ok', runs: this.registry.size })
      return
    }

    if (req.method === 'POST' && url.pathname === `${prefix}/agent/run`) {
      const raw = await readBody(req)
      let parsed: RunRequest
      try {
        parsed = RunRequestSchema.parse(JSON.parse(raw))
      } catch (err) {
        send(400, {
          error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }
      // The agent must be supplied by the caller via a
      // factory at composition time. This adapter doesn't
      // own the Agent lifecycle; it routes requests.
      send(501, {
        error:
          'Agent factory not configured. Use createNodeServer() instead of constructing NodeHttpAdapter directly.',
      })
      return
    }

    const agentMatch = url.pathname.match(
      new RegExp(`^${prefix}/agent/([^/]+)(/cancel)?$`),
    )
    if (agentMatch) {
      const id = agentMatch[1]
      if (!id) {
        send(400, { error: 'Missing run id' })
        return
      }
      if (req.method === 'GET' && !agentMatch[2]) {
        const run = this.registry.get(id)
        send(run ? 200 : 404, run ?? { error: 'run not found' })
        return
      }
      if (req.method === 'POST' && agentMatch[2]) {
        const cancelled = this.registry.cancel(id)
        send(cancelled ? 200 : 404, { cancelled })
        return
      }
    }

    send(404, { error: 'not found' })
  }

  // -------------------------------------------------------------------------
  // WebSocket streaming
  // -------------------------------------------------------------------------

  private async handleWs(ws: import('ws').WebSocket, runId: string): Promise<void> {
    const run = this.registry.get(runId)
    if (!run) {
      ws.close(4404, 'run not found')
      return
    }
    try {
      for await (const ev of run.agent.streamRun({
        userMessage: '', // caller must set this on registration
        signal: run.abortController.signal,
      })) {
        ws.send(JSON.stringify(ev))
      }
      ws.close()
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', error: errMessage(err) }))
      ws.close()
    }
  }
}

// ---------------------------------------------------------------------------
// createNodeServer — top-level convenience
// ---------------------------------------------------------------------------

/** Read the request body as a string. */
const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })

/** Coerce any thrown value to a human-readable message. */
const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/** Zod schema for {@link CreateServerOptions}. */
export const CreateServerOptionsSchema = z.object({
  /** Factory that creates an Agent per run. */
  agentFactory: z.custom<(req: RunRequest) => Agent>(
    (v) => typeof v === 'function',
  ),
  port: z.number().int().nonnegative().default(0),
  host: z.string().default('127.0.0.1'),
  pathPrefix: z.string().default('/v1'),
})

/** Options for {@link createNodeServer}. */
export type CreateServerOptions = z.input<typeof CreateServerOptionsSchema>

/**
 * The recommended way to start a server. Wires the agent
 * factory into the routing layer.
 */
export const createNodeServer = (
  options: CreateServerOptions,
): { adapter: NodeHttpAdapter; start: () => Promise<void>; stop: () => Promise<void> } => {
  const parsed = CreateServerOptionsSchema.parse(options)
  const registry = new RunRegistry()

  const adapter = new NodeHttpAdapter(registry, {
    port: parsed.port,
    host: parsed.host,
    pathPrefix: parsed.pathPrefix,
  })

  // We override the routing for /v1/agent/run to inject
  // the agent factory. The simplest path: subclass.
  class FactoryAwareAdapter extends NodeHttpAdapter {
    public override async start(): Promise<void> {
      // Replace the http handler with one that uses the
      // factory. Done by overriding `handleHttp` via a
      // fresh server instance in this method.
      const { createServer } = await import('node:http')
      const { WebSocketServer } = await import('ws')

      const server = createServer(async (req, res) => {
        await this.routeWithFactory(req, res, parsed.agentFactory)
      })
      const wss = new WebSocketServer({ noServer: true })
      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const match = url.pathname.match(
          new RegExp(`^${parsed.pathPrefix}/agent/([^/]+)/stream$`),
        )
        if (!match) {
          socket.destroy()
          return
        }
        const runId = match[1]
        if (!runId) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          // Same stream logic as base class.
          const run = registry.get(runId)
          if (!run) {
            ws.close(4404, 'run not found')
            return
          }
          void (async () => {
            try {
              for await (const ev of run.agent.streamRun({
                userMessage: '',
                signal: run.abortController.signal,
              })) {
                ws.send(JSON.stringify(ev))
              }
              ws.close()
            } catch (err) {
              ws.send(JSON.stringify({ type: 'error', error: errMessage(err) }))
              ws.close()
            }
          })()
        })
      })

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(parsed.port, parsed.host, () => resolve())
      })
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        ;(this as unknown as { _port: number })._port = addr.port
      }
      ;(this as unknown as { server: unknown }).server = server
      ;(this as unknown as { _running: boolean })._running = true
    }

    private async routeWithFactory(
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
      factory: (req: RunRequest) => Agent,
    ): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const prefix = parsed.pathPrefix
      const send = (status: number, body: unknown): void => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      }

      if (req.method === 'GET' && url.pathname === `${prefix}/health`) {
        send(200, { status: 'ok', runs: registry.size })
        return
      }

      if (req.method === 'POST' && url.pathname === `${prefix}/agent/run`) {
        const raw = await readBody(req)
        let body: RunRequest
        try {
          body = RunRequestSchema.parse(JSON.parse(raw))
        } catch (err) {
          send(400, {
            error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
          })
          return
        }
        const agent = factory(body)
        const abort = new AbortController()
        const id = registry.register(agent, abort)
        try {
          const result = await agent.run({
            userMessage: body.userMessage,
            ...(body.sessionId ? { sessionId: body.sessionId } : {}),
            ...(body.maxIterations ? { maxIterations: body.maxIterations } : {}),
            signal: abort.signal,
          })
          registry.finish(id)
          send(200, result)
        } catch (err) {
          registry.finish(id)
          send(500, { error: errMessage(err) })
        }
        return
      }

      const agentMatch = url.pathname.match(
        new RegExp(`^${prefix}/agent/([^/]+)(/cancel)?$`),
      )
      if (agentMatch) {
        const id = agentMatch[1]
        if (!id) {
          send(400, { error: 'Missing run id' })
          return
        }
        if (req.method === 'GET' && !agentMatch[2]) {
          const run = registry.get(id)
          send(run ? 200 : 404, run ?? { error: 'run not found' })
          return
        }
        if (req.method === 'POST' && agentMatch[2]) {
          const cancelled = registry.cancel(id)
          send(cancelled ? 200 : 404, { cancelled })
          return
        }
      }

      send(404, { error: 'not found' })
    }
  }

  const factoryAdapter = new FactoryAwareAdapter(registry, {
    port: parsed.port,
    host: parsed.host,
    pathPrefix: parsed.pathPrefix,
  })
  return {
    adapter: factoryAdapter,
    start: () => factoryAdapter.start(),
    stop: () => factoryAdapter.stop(),
  }
}

// ---------------------------------------------------------------------------
// Stream helper for tests / external consumers
// ---------------------------------------------------------------------------

/** Convert a run event generator to an AsyncIterable of strings (JSON lines). */
export const streamToJsonLines = async function* (
  events: AsyncIterable<RunEvent>,
): AsyncGenerator<string> {
  for await (const ev of events) {
    yield JSON.stringify(ev) + '\n'
  }
}