/**
 * P35.b — `lumen config show --section <name>`.
 *
 * Pure options redactor on the already-merged config.
 * The redact helper is exported indirectly via the
 * `configShowCommand` round-trip; we exercise the
 * section branch by reading the JSON output and
 * asserting the shape.
 */

import { describe, expect, it } from 'vitest'
import { configShowCommand } from '../src/commands/config.js'

describe('configShowCommand --section — P35.b', () => {
  it('emits a single-section JSON object when --section is set', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await configShowCommand({ section: 'agent' })
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as { maxIterations?: number }
      // The agent section is always present in the
      // built-in defaults (Zod schema guarantees a
      // default `maxIterations`).
      expect(typeof parsed.maxIterations).toBe('number')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits an empty JSON object for an unknown section name', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await configShowCommand({ section: 'does-not-exist' })
      expect(code).toBe(0)
      expect(writes.join('').trim()).toBe('{}')
    } finally {
      process.stdout.write = originalWrite
    }
  })

  it('emits the full redacted config when --section is omitted (pre-P35.b behaviour)', async () => {
    const writes: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    }) as typeof process.stdout.write
    try {
      const code = await configShowCommand()
      expect(code).toBe(0)
      const parsed = JSON.parse(writes.join('')) as Record<string, unknown>
      // Every top-level section in the merged config is
      // present (none of them are sliced off).
      expect(Object.keys(parsed).length).toBeGreaterThan(1)
    } finally {
      process.stdout.write = originalWrite
    }
  })
})
