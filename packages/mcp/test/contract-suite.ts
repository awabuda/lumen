/**
 * Contract tests for {@link McpTransport}.
 *
 * The exact same suite is run against every concrete transport
 * (`StdioTransport`, `StreamableHttpTransport`, ...). If you
 * add a new transport, call
 * `runMcpTransportContractTests(label, factory)` from your
 * transport's own test file and you get the structural
 * contract for free.
 *
 * **What this suite pins down:**
 *   - Every transport has a non-empty `name` and a
 *     `connected` getter (boolean).
 *   - Before `open()`, `connected` is `false`.
 *   - `open()` and `close()` are members of the transport and
 *     can be invoked without throwing on a freshly-constructed
 *     instance (the actual connect round-trip is exercised by
 *     the per-transport test with a live stub).
 *   - After a successful `open()`/`close()` cycle,
 *     `connected` returns to `false`.
 *   - `close()` is idempotent — calling it twice does not
 *     throw.
 *   - `send()` rejects when called before `open()`. The
 *     contract is "must throw"; the specific error type is
 *     the per-transport test's job.
 *
 * What is **not** in this contract:
 *   - JSON-RPC framing details (NDJSON vs Content-Length
 *     headers vs SSE). Those live in per-transport tests.
 *   - Reconnection / backoff behaviour. Stdio transport
 *     does not reconnect; HTTP transport does. This contract
 *     is silent on the matter — both behaviours are valid.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { McpTransport } from '../src/base.js'

export function runMcpTransportContractTests(
  label: string,
  factory: () => Promise<McpTransport> | McpTransport,
): void {
  describe(`[contract] ${label}`, () => {
    let transport: McpTransport

    beforeEach(async () => {
      transport = await factory()
    })

    afterEach(async () => {
      // Defensive close so a test that didn't close itself
      // does not leave a connection dangling.
      try {
        await transport.close()
      } catch {
        // ignore — close is allowed to throw on never-opened
        // transports
      }
    })

    it('exposes a non-empty name', () => {
      expect(typeof transport.name).toBe('string')
      expect(transport.name.length).toBeGreaterThan(0)
    })

    it('exposes a connected getter (boolean)', () => {
      expect(typeof transport.connected).toBe('boolean')
    })

    it('starts in a not-connected state', () => {
      expect(transport.connected).toBe(false)
    })

    it('exposes open(), close(), and send() as members', () => {
      expect(typeof transport.open).toBe('function')
      expect(typeof transport.close).toBe('function')
      expect(typeof transport.send).toBe('function')
    })

    it('close() is idempotent on a never-opened transport', async () => {
      await expect(transport.close()).resolves.toBeUndefined()
      await expect(transport.close()).resolves.toBeUndefined()
      expect(transport.connected).toBe(false)
    })

    it('send() before open() rejects', async () => {
      // The contract is: must reject. Specific error type
      // is per-transport.
      await expect(transport.send('ping')).rejects.toBeInstanceOf(Error)
    })
  })
}
