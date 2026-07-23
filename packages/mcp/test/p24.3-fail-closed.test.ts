/**
 * P24.3 \u2014 fail-closed MCP server registration (bug.md #47).
 *
 * Verifies:
 *   1. `failClosed: true` (default) + empty `allowServerIds`
 *      refuses EVERY server (per-server refuse line).
 *   2. `failClosed: true` + an `allowServerIds` list refuses
 *      servers not on the list and accepts those that are.
 *   3. `failClosed: false` accepts every server (legacy
 *      opt-out) AND emits the documented stderr warning.
 *   4. `isServerIdAllowed()` is a pure helper that matches the
 *      same policy as the gate.
 */

import { describe, expect, it } from 'vitest'

import {
  connectAllMcpServers,
  isServerIdAllowed,
  type McpSecurityOptions,
} from '../src/discover.js'
import type { McpServerConfig } from '@lumen/config'
import { ToolRegistry } from '@lumen/core'

// Server configs whose command is intentionally non-functional
// (`command: 'noop'`) \u2014 the gate must fire BEFORE the connect
// attempt for the off-list id. If a non-allow-listed id reached
// the connect path the test would error with a different
// message (`failed to connect` rather than `refuse`).
const makeServers = (): Array<{ name: string } & McpServerConfig> => [
  { name: 'github', command: 'noop', args: [] },
  { name: 'slack', command: 'noop', args: [] },
  { name: 'internal', command: 'noop', args: [] },
]

const silent = (): { stderr: string[]; restore: () => void } => {
  const captured: string[] = []
  const orig = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: capture writes
  process.stderr.write = ((chunk: any, ...rest: unknown[]) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as unknown as typeof process.stderr.write
  return {
    stderr: captured,
    restore: () => {
      process.stderr.write = orig
    },
  }
}

describe('isServerIdAllowed \u2014 P24.3 fail-closed policy', () => {
  it('failClosed defaults to true', () => {
    // Default policy: allow-list is empty => nothing allowed.
    expect(isServerIdAllowed('github')).toBe(false)
  })

  it('failClosed:true + non-empty allowServerIds permits listed ids', () => {
    const sec: McpSecurityOptions = {
      failClosed: true,
      allowServerIds: ['github', 'slack'],
    }
    expect(isServerIdAllowed('github', sec)).toBe(true)
    expect(isServerIdAllowed('slack', sec)).toBe(true)
    expect(isServerIdAllowed('internal', sec)).toBe(false)
  })

  it('failClosed:false permits every id (legacy opt-out)', () => {
    expect(isServerIdAllowed('anything', { failClosed: false })).toBe(true)
    expect(isServerIdAllowed('github', { failClosed: false })).toBe(true)
  })
})

describe('connectAllMcpServers \u2014 P24.3 fail-closed gate', () => {
  it('failClosed:true with empty allowServerIds refuses every server', async () => {
    const s = silent()
    try {
      const out = await connectAllMcpServers(
        makeServers(),
        new ToolRegistry(),
        { timeoutMs: 1_000 },
        // Empty allow-list => every per-server task refuses.
        { allowServerIds: [] },
      )
      expect(out).toEqual([])
      const joined = s.stderr.join('')
      expect(joined).toMatch(/refuse: server "github" is not on/)
      expect(joined).toMatch(/refuse: server "slack" is not on/)
      expect(joined).toMatch(/refuse: server "internal" is not on/)
    } finally {
      s.restore()
    }
  })

  it('failClosed:true with allowServerIds permits listed servers only', async () => {
    const s = silent()
    try {
      const out = await connectAllMcpServers(
        makeServers(),
        new ToolRegistry(),
        { timeoutMs: 1_000 },
        { allowServerIds: ['github', 'slack'] },
      )
      // Every server fails to connect (`noop` is not a real
      // binary on PATH), but the off-list id is refused
      // BEFORE the connect call. We assert on the stderr
      // pattern, not the return value.
      expect(out).toEqual([])
      const joined = s.stderr.join('')
      expect(joined).toMatch(/refuse: server "internal" is not on/)
      expect(joined).not.toMatch(/refuse: server "github" is not on/)
      expect(joined).not.toMatch(/refuse: server "slack" is not on/)
    } finally {
      s.restore()
    }
  })

  it('failClosed:false accepts every server and prints the opt-out warning', async () => {
    const s = silent()
    try {
      await connectAllMcpServers(
        makeServers(),
        new ToolRegistry(),
        { timeoutMs: 1_000 },
        { failClosed: false },
      )
      const joined = s.stderr.join('')
      expect(joined).toMatch(/MCP fail-closed posture is OFF/)
    } finally {
      s.restore()
    }
  })
})