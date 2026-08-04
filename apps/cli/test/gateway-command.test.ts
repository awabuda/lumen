/**
 * P34.4 (Phase B.4) — minimum Gateway tests.
 *
 * Verifies the command module's surface (status + stop)
 * and the gateway flag parsing without actually
 * starting a Node HTTP server (that path requires a
 * real LLM key + network and is exercised by the
 * `real-model` E2E harness, not these unit tests).
 */

import { describe, expect, it } from 'vitest'
import { gatewayStatusCommand, gatewayStopCommand } from '../src/commands/gateway.js'

describe('gatewayStopCommand — P34.4', () => {
  it('prints a not-running message and returns 0', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await gatewayStopCommand()
      expect(code).toBe(0)
      expect(writes.join('')).toMatch(/not running as a daemon/)
    } finally {
      process.stdout.write = originalWrite
    }
  })
})

describe('gatewayStatusCommand — P34.4', () => {
  it('prints the planned endpoint with defaults', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await gatewayStatusCommand({})
      expect(code).toBe(0)
      const out = writes.join('')
      expect(out).toMatch(/lumen gateway status: not running/)
      expect(out).toMatch(/planned endpoint: http:\/\/127\.0\.0\.1:<random>\/v1/)
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('respects explicit port + host + pathPrefix', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await gatewayStatusCommand({
        port: 7777,
        host: '0.0.0.0',
        pathPrefix: '/api',
      })
      expect(code).toBe(0)
      expect(writes.join('')).toMatch(/planned endpoint: http:\/\/0\.0\.0\.0:7777\/api/)
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
