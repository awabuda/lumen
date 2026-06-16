/**
 * Wires {@link runMcpTransportContractTests} against every
 * concrete transport shipped by `@lumen/mcp`. The wrapper is
 * its own file so the per-transport test files (which focus
 * on framing / reconnection / wire-format details) stay
 * focused.
 *
 * If you add a new transport, add another
 * `runXxxTransportContractTests` block here — no other change
 * is required.
 *
 * Note: the transports are constructed with the minimum
 * options needed to be valid instances. We do NOT call
 * `open()` here — the per-transport test exercises the
 * open/close round-trip with a live (or stub) process. The
 * contract only requires that the *structural* surface
 * (id, connected, open, close, send-before-open rejection,
 * idempotent close) is correct.
 */

import { StdioMcpTransport } from '../src/stdio-transport.js'
import { HttpMcpTransport } from '../src/http-transport.js'
import { runMcpTransportContractTests } from './contract-suite.js'

runMcpTransportContractTests(
  'StdioMcpTransport',
  () =>
    // We never call open() in the contract — passing a
    // non-existent command is fine because open() is exercised
    // in stdio-transport.test.ts, not here.
    new StdioMcpTransport({ command: '/nonexistent/contract-probe' }),
)

runMcpTransportContractTests(
  'HttpMcpTransport',
  () =>
    // Same reasoning: we do not open the URL in the contract.
    new HttpMcpTransport({ url: 'http://127.0.0.1:1/contract-probe' }),
)
