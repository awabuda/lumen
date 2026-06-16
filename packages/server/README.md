# @lumen/server

HTTP + WebSocket adapter for the Lumen agent. The single source of
truth for the network protocol that the CLI, the web dashboard, and
the desktop client use to drive a remote agent.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/agent/run` | Start a new run |
| `GET` | `/v1/agent/:id` | Get run status |
| `POST` | `/v1/agent/:id/cancel` | Cancel a run |
| `GET` | `/v1/health` | Health check |
| `WS` | `/v1/agent/:id/stream` | Stream `RunEvent` deltas |

## Quick start

```ts
import { createLumenServer, NodeHttpAdapter } from '@lumen/server'

const server = createLumenServer({
  adapter: new NodeHttpAdapter({ port: 7700 }),
  agent: myAgent,
})

await server.start()
```

The transport is pluggable via `BaseServerAdapter`; the Node
`http` module ships as `NodeHttpAdapter`. Custom adapters can wrap
Fastify, Express, Bun.serve, or any other HTTP primitive.

## Why a separate package

The CLI, the web dashboard, the desktop client, and the editor
extension all need a way to drive the agent over the network. Putting
the protocol in its own package keeps the wire format versioned
independently of the agent runtime.

## License

MIT
