---
"@lumen/cli": minor
---

P34.4 — `lumen gateway start|stop|status` subcommand (Phase B.4 closure).

The CLI now ships a long-lived Node daemon that
exposes the agent over HTTP + WebSocket. The gateway
reuses `buildAgent` (the assistant assembly: plan /
permission / skill / reflection / memory bridge) and
wires it as `createNodeServer`'s `agentFactory`.

Surface:

- `apps/cli/src/commands/gateway.ts`:
  - `gatewayStartCommand({port?, host?, pathPrefix?})` —
    builds Agent + starts NodeHttpAdapter + installs
    SIGINT/SIGTERM graceful-shutdown.
  - `gatewayStopCommand()` — P34.4 stub; daemon mode
    is a future P-ticket.
  - `gatewayStatusCommand()` — prints the planned
    endpoint.
- `apps/cli/src/index.ts` — registers `lumen gateway`
  with `--port / --host / --path-prefix` flags.
- `apps/cli/package.json` — adds `@lumen/server`
  workspace dependency.

End-to-end verified:
  `lumen gateway status --port 8888` →
    `planned endpoint: http://127.0.0.1:8888/v1`

Test counts: cli 371 → 374 (+3); monorepo 1873 tests /
0 fail / biome clean on touched files.