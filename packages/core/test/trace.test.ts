/** P20.8 e2e: observability / trace context. */

import { describe, expect, it } from 'vitest'
import {
  createTrace,
  formatTrace,
  runWithTrace,
} from '../src/trace.js'

describe('createTrace', () => {
  it('generates 16-hex-char traceId and spanId by default', () => {
    const t = createTrace()
    expect(t.traceId).toMatch(/^[0-9a-f]{16}$/)
    expect(t.spanId).toMatch(/^[0-9a-f]{16}$/)
  })

  it('accepts overrides for traceId and spanId', () => {
    const t = createTrace({
      traceId: '0123456789abcdef',
      spanId: 'fedcba9876543210',
    })
    expect(t.traceId).toBe('0123456789abcdef')
    expect(t.spanId).toBe('fedcba9876543210')
  })

  it('accepts an optional parentSpanId and name', () => {
    const parent = createTrace()
    const child = createTrace({
      parentSpanId: parent.spanId,
      name: 'child-span',
    })
    expect(child.parentSpanId).toBe(parent.spanId)
    expect(child.name).toBe('child-span')
  })

  it('omits parentSpanId and name when not set', () => {
    const t = createTrace()
    expect(t.parentSpanId).toBeUndefined()
    expect(t.name).toBeUndefined()
  })

  it('rejects a traceId of the wrong length or non-hex content', () => {
    expect(() => createTrace({ traceId: 'short' })).toThrow(/traceId/)
    expect(() => createTrace({ traceId: 'Z'.repeat(16) })).toThrow(/traceId/)
  })

  it('rejects a spanId of the wrong length or non-hex content', () => {
    expect(() => createTrace({ spanId: 'short' })).toThrow(/spanId/)
    expect(() => createTrace({ spanId: 'G'.repeat(16) })).toThrow(/spanId/)
  })

  it('rejects a parentSpanId of the wrong length', () => {
    expect(() =>
      createTrace({ parentSpanId: 'bad' }),
    ).toThrow(/parentSpanId/)
  })

  it('records startedAt at construction time', () => {
    const before = Date.now()
    const t = createTrace()
    const after = Date.now()
    expect(t.startedAt).toBeGreaterThanOrEqual(before)
    expect(t.startedAt).toBeLessThanOrEqual(after)
  })

  it('generates a unique spanId per call', () => {
    const a = createTrace()
    const b = createTrace()
    expect(a.spanId).not.toBe(b.spanId)
  })
})

describe('runWithTrace', () => {
  it('forwards the trace to the runner', async () => {
    const t = createTrace({ name: 'outer' })
    const result = await runWithTrace(t, async (trace) => {
      expect(trace).toBe(t)
      return trace.traceId
    })
    expect(result).toBe(t.traceId)
  })

  it('propagates runner errors without rethrowing as a new error', async () => {
    const t = createTrace()
    await expect(
      runWithTrace(t, async () => {
        throw new Error('runner failed')
      }),
    ).rejects.toThrow('runner failed')
  })

  it('returns the runner return value unchanged', async () => {
    const t = createTrace()
    const out = await runWithTrace(t, async () => 42)
    expect(out).toBe(42)
  })
})

describe('formatTrace', () => {
  it('renders traceId, spanId, parent, and name on a single line', () => {
    const t = createTrace({
      traceId: '0123456789abcdef',
      spanId: 'fedcba9876543210',
      parentSpanId: '0011223344556677',
      name: 'demo',
    })
    const line = formatTrace(t)
    expect(line).toContain('0123456789abcdef')
    expect(line).toContain('fedcba9876543210')
    expect(line).toContain('parent=0011223344556677')
    expect(line).toContain('demo')
  })

  it('omits the parent segment when no parent is set', () => {
    const t = createTrace({ name: 'solo' })
    const line = formatTrace(t)
    expect(line).not.toContain('parent=')
  })
})
