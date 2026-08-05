/**
 * Phase B.4 / P34.4 — Minimum Gateway.
 *
 * `lumen gateway start` runs a long-lived Node process
 * that exposes the agent over HTTP + WebSocket via
 * `@lumen/server`. The gateway reuses
 * `apps/cli/src/composition.ts`'s `buildAgent` so the
 * operator's assistant assembly (plan / permission /
 * skill / reflection / memory bridge) all carry over
 * unchanged from `lumen run` / `lumen chat`.
 *
 * Why this lives in `apps/cli` (and not `@lumen/server`):
 *   - the gateway IS the CLI composition root plus a
 *     thin server adapter. Pushing it into @lumen/server
 *     would mean either moving the composition root
 *     into @lumen/core (breaks P19+ tier isolation) or
 *     importing composition.ts from the server package
 *     (inverts the dep graph — @lumen/server would
 *     depend on @lumen/cli's transitive app state).
 *   - per OPTIMIZATION-PLAN §3 B.4 § DI-boundary table:
 *     `apps/gateway | apps/cli` is the only allowed
 *     caller of `@lumen/server` + `buildAgent`. The
 *     server package owns the protocol; the CLI owns
 *     the composition.
 *
 * Surface:
 *   - `lumen gateway start [--port <n>] [--host <h>]`
 *     starts the server (foreground; Ctrl+C stops).
 *   - `lumen gateway stop` (no-op stub for P34.4 — the
 *     single-process model means the operator just
 *     Ctrl+C; future P-ticket can wire pidfile + IPC).
 *   - `lumen gateway status` prints the resolved host /
 *     port and route map.
 */

import { type RunRequest, createNodeServer } from '@lumen/server'
import { buildAgent } from '../composition.js'

export interface GatewayCommandOptions {
  /** Port to listen on. 0 picks a random free port. */
  readonly port?: number
  /** Host to bind. Default `127.0.0.1` (loopback only). */
  readonly host?: string
  /** Path prefix for all routes. Default `/v1`. */
  readonly pathPrefix?: string
  /**
   * P43.d — `status` action only. Output format.
   * 'human' (default) is the pre-P43.d one-line
   * text; 'json' emits a structured object
   * (CI-friendly). Brings `status` to parity with
   * the other CLI surfaces that already honour
   * the `--format` flag.
   */
  readonly format?: 'human' | 'json'
}

/**
 * Start the gateway. Returns once the server is
 * listening; the caller owns process lifetime and is
 * responsible for installing SIGINT/SIGTERM handlers.
 */
export const gatewayStartCommand = async (
  options: GatewayCommandOptions = {},
): Promise<{
  readonly port: number
  readonly host: string
  readonly stop: () => Promise<void>
}> => {
  // Build one agent up front (composition root). The
  // server's `agentFactory` reuses this base agent for
  // every incoming request, threading the operator's
  // cwd / api key / skills dir through the env. A
  // future P-ticket can replace this with a per-request
  // factory when gateway sessions need their own
  // SqliteStore / PlanStore.
  const built = await buildAgent({ noMemory: false })

  const server = createNodeServer({
    agentFactory: (_req: RunRequest): typeof built.agent => built.agent,
    ...(options.port !== undefined ? { port: options.port } : { port: 0 }),
    host: options.host ?? '127.0.0.1',
    pathPrefix: options.pathPrefix ?? '/v1',
  })

  await server.start()
  const resolved = server.adapter
  process.stdout.write(
    `lumen gateway: listening on http://${options.host ?? '127.0.0.1'}:${resolved.port}${options.pathPrefix ?? '/v1'}\n`,
  )
  process.stdout.write('  POST /v1/agent/run      — start a run\n')
  process.stdout.write('  GET  /v1/agent/:id      — get run status\n')
  process.stdout.write('  POST /v1/agent/:id/cancel — cancel a run\n')
  process.stdout.write('  GET  /v1/health         — health check\n')
  process.stdout.write('  WS   /v1/agent/:id/stream — streaming events\n')
  return {
    port: resolved.port,
    host: options.host ?? '127.0.0.1',
    stop: async () => {
      await server.stop()
      await built.memory?.dispose()
    },
  }
}

/**
 * Print the resolved gateway status. We don't keep
 * state across processes (single-process model per
 * P34.4 §DI-boundary), so this just echoes the
 * resolved host/port for the operator to copy into
 * a curl command.
 */
export const gatewayStatusCommand = async (
  options: GatewayCommandOptions = {},
): Promise<number> => {
  // Same composition root, but the server doesn't
  // actually start — we just resolve the port
  // allocator and report the planned endpoint. To keep
  // the scope tight, this command prints a "not running"
  // status line; future P-ticket can read a pidfile
  // (Phase C gateway UI work).
  const port = options.port ?? 0
  const host = options.host ?? '127.0.0.1'
  const pathPrefix = options.pathPrefix ?? '/v1'
  // P43.d — emit a JSON object on `status`. The
  // shape mirrors the human output verbatim.
  if (options.format === 'json') {
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'not-running',
          plannedEndpoint: `http://${host}:${port === 0 ? '<random>' : String(port)}${pathPrefix}`,
          host,
          port,
          pathPrefix,
        },
        null,
        2,
      )}\n`,
    )
    return 0
  }
  process.stdout.write(
    `lumen gateway status: not running (no pidfile yet; future P-ticket wires daemon mode)\nplanned endpoint: http://${host}:${port === 0 ? '<random>' : String(port)}${pathPrefix}\n`,
  )
  return 0
}

/**
 * `lumen gateway stop` — P34.4 stub. Single-process
 * model means the operator Ctrl+C's the foreground
 * `lumen gateway start`. Future P-ticket (Phase C) can
 * add a pidfile + IPC channel for daemon mode.
 */
export const gatewayStopCommand = async (): Promise<number> => {
  process.stdout.write(
    'lumen gateway stop: not running as a daemon (Ctrl+C the foreground `lumen gateway start` process)\n',
  )
  return 0
}
