/** Tests for the telemetry collector. */

import { describe, expect, it } from 'vitest'
import { ConsoleTelemetryBackend, NoopTelemetryBackend, TelemetryCollector } from '../src/telemetry/index.js'

describe('NoopTelemetryBackend', () => {
  it('does nothing on emit', () => {
    const backend = new NoopTelemetryBackend()
    backend.emit({
      runCount: 1,
      toolCalls: 3,
      iterations: 2,
      durationMs: 100,
      providerId: 'openai',
      model: 'gpt-4o',
      timestamp: 0,
    })
    // No assertion needed — just verifying no throw.
  })
})

describe('ConsoleTelemetryBackend', () => {
  it('writes JSON to stderr', () => {
    const backend = new ConsoleTelemetryBackend()
    let output = ''
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })
    backend.emit({
      runCount: 1,
      toolCalls: 3,
      iterations: 2,
      durationMs: 100,
      providerId: 'openai',
      model: 'gpt-4o',
      timestamp: 0,
    })
    expect(output).toContain('"runCount":1')
    expect(output).toContain('"providerId":"openai"')
    spy.mockRestore()
  })
})

describe('TelemetryCollector', () => {
  it('increments run count on each record', () => {
    const collector = new TelemetryCollector()
    expect(collector.runs).toBe(0)
    collector.record({ toolCalls: 1, iterations: 1, durationMs: 50, providerId: 'test', model: 'test' })
    expect(collector.runs).toBe(1)
    collector.record({ toolCalls: 2, iterations: 2, durationMs: 100, providerId: 'test', model: 'test' })
    expect(collector.runs).toBe(2)
  })
})
