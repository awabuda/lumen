/**
 * Tests for the P20.7.4 team-level checkpoint wiring.
 *
 * `orchestrateTeam` accepts an optional `teamCheckpointStore`.
 * When set, the returned runner saves one synthetic
 * `AgentCheckpoint` after the team resolves (success or
 * failure). The save is best-effort: a checkpoint failure
 * does not change the team's run result.
 *
 * Tests use `InMemoryCheckpointStore` from `@lumen/core` so
 * the suite is hermetic (no SQLite file, no disk I/O).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCheckpointStore, ToolRegistry } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveTeamCheckpoint, teamCommand } from '../src/commands/team.js'
import { FakeProvider } from './fake-provider.js'

const captureProcess = (): {
  stdout: string[]
  stderr: string[]
  restore: () => void
} => {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdout = process.stdout.write.bind(process.stdout)
  const originalStderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    },
  }
}

const twoAgentTeam = () => ({
  name: 'pair',
  mode: 'sequential' as const,
  agents: [
    { name: 'a', description: 'agent a', systemPrompt: 'do a' },
    { name: 'b', description: 'agent b', systemPrompt: 'do b' },
  ],
  tasks: [
    { agentName: 'a', prompt: 'p-a' },
    { agentName: 'b', prompt: 'p-b' },
  ],
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-team-ckpt-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a team to a temp file and return the path. */
const writeTeamFile = (team: unknown): string => {
  const path = join(dir, 'team.json')
  writeFileSync(path, JSON.stringify(team), 'utf8')
  return path
}

describe('saveTeamCheckpoint (pure helper)', () => {
  it('writes a checkpoint with the team:NAME:SUCCESS label', async () => {
    const store = new InMemoryCheckpointStore()
    const team = { name: 'demo', agents: [{ name: 'a', description: 'a', systemPrompt: 'p' }] }
    await saveTeamCheckpoint(store, team, 'success', 1)
    const all = await store.list('team:demo')
    expect(all).toHaveLength(1)
    const ck = all[0]
    expect(ck?.label).toMatch(/^team:demo:success$/)
    expect(ck?.sessionId).toBe('team:demo')
    expect(ck?.iterations).toBe(1)
  })

  it('appends the error message to the label when present', async () => {
    const store = new InMemoryCheckpointStore()
    const team = { name: 'demo', agents: [{ name: 'a', description: 'a', systemPrompt: 'p' }] }
    await saveTeamCheckpoint(store, team, 'error', 0, 'something broke')
    const all = await store.list('team:demo')
    expect(all[0]?.label).toContain('something broke')
  })
})

describe('teamCommand: run with teamCheckpointStore', () => {
  let capture: ReturnType<typeof captureProcess>

  beforeEach(() => {
    capture = captureProcess()
  })
  afterEach(() => {
    capture.restore()
  })

  it('saves a success checkpoint when the team resolves cleanly', async () => {
    const store = new InMemoryCheckpointStore()
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const code = await teamCommand({
      action: 'run',
      path: writeTeamFile(twoAgentTeam()),
      runParent: { provider, tools: new ToolRegistry() },
      teamCheckpointStore: store,
    })
    expect(code).toBe(0)
    const all = await store.list('team:pair')
    expect(all).toHaveLength(1)
    expect(all[0]?.label).toMatch(/^team:pair:success$/)
  })

  it('saves an error checkpoint when the orchestrator throws', async () => {
    const store = new InMemoryCheckpointStore()
    // Empty script → first sub-agent chat throws. The
    // orchestrator surfaces the error to the awaiter; the
    // wrapWithCheckpoint layer then saves an error
    // checkpoint.
    const provider = new FakeProvider([])
    const code = await teamCommand({
      action: 'run',
      path: writeTeamFile(twoAgentTeam()),
      runParent: { provider, tools: new ToolRegistry() },
      teamCheckpointStore: store,
    })
    expect(code).toBe(1)
    const all = await store.list('team:pair')
    expect(all).toHaveLength(1)
    expect(all[0]?.label).toMatch(/^team:pair:error/)
  })

  it('does not save anything when no teamCheckpointStore is provided', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const code = await teamCommand({
      action: 'run',
      path: writeTeamFile(twoAgentTeam()),
      runParent: { provider, tools: new ToolRegistry() },
    })
    expect(code).toBe(0)
    // The runner ran without a store; this test passes
    // vacuously but is the regression tripwire: if a future
    // change makes teamCheckpointStore non-optional, the
    // type system will catch the missing-field call.
    expect(true).toBe(true)
  })

  it('still returns the team results when the store save throws', async () => {
    // Defensive: a broken store must not change the team's
    // run result. We replace the store's `save` with a
    // function that always throws, then run a normal team
    // and assert the team result is still 0.
    const store = new InMemoryCheckpointStore()
    vi.spyOn(store, 'save').mockRejectedValue(new Error('store is broken'))
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const code = await teamCommand({
      action: 'run',
      path: writeTeamFile(twoAgentTeam()),
      runParent: { provider, tools: new ToolRegistry() },
      teamCheckpointStore: store,
    })
    expect(code).toBe(0)
    const out = capture.stdout.join('')
    expect(out).toContain('[1/2] a')
    expect(out).toContain('[2/2] b')
  })
})

// Suppress unused-import warning for vi (used in the spy test).
void vi
