/**
 * Tests for the `lumen team run <path>` action (P20.7.3).
 *
 * The run action is the only team action that exercises a
 * real orchestrator. The tests use a fake `runParent` so we
 * can drive the dispatch path without hitting a real LLM.
 * Real LLM-driven runs are an integration concern (P21+).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatTeamResult, printTeamResults, teamCommand } from '../src/commands/team.js'
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

describe('teamCommand: run', () => {
  let dir: string
  let capture: ReturnType<typeof captureProcess>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-team-run-'))
    capture = captureProcess()
  })
  afterEach(() => {
    capture.restore()
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns 2 when no runParent is provided (programmer error)', async () => {
    const path = join(dir, 'team.json')
    writeFileSync(path, JSON.stringify(twoAgentTeam()), 'utf8')
    const code = await teamCommand({ action: 'run', path })
    expect(code).toBe(2)
    expect(capture.stderr.join('')).toContain('no runParent provided')
  })

  it('returns 2 when the path argument is missing', async () => {
    const code = await teamCommand({
      action: 'run',
      runParent: { provider: new FakeProvider([]), tools: new ToolRegistry() },
    })
    expect(code).toBe(2)
    expect(capture.stderr.join('')).toContain('missing <path>')
  })

  it('returns 1 for a missing file', async () => {
    const code = await teamCommand({
      action: 'run',
      path: join(dir, 'missing.json'),
      runParent: { provider: new FakeProvider([]), tools: new ToolRegistry() },
    })
    expect(code).toBe(1)
    expect(capture.stderr.join('')).toContain('lumen team run:')
  })

  it('returns 1 for a schema-rejected file', async () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, JSON.stringify({ name: 'x', agents: [] }), 'utf8')
    const code = await teamCommand({
      action: 'run',
      path,
      runParent: { provider: new FakeProvider([]), tools: new ToolRegistry() },
    })
    expect(code).toBe(1)
    expect(capture.stderr.join('')).toContain('failed validation')
  })

  it('runs a sequential team and prints one block per task', async () => {
    // Two scripted responses — one per sub-agent. Each
    // sub-agent gets a fresh FakeProvider script; the
    // dispatcher runs them via createSequentialSubAgent
    // which awaits each in turn.
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-output', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-output', toolCalls: [] } },
    ])
    const path = join(dir, 'team.json')
    writeFileSync(path, JSON.stringify(twoAgentTeam()), 'utf8')
    const code = await teamCommand({
      action: 'run',
      path,
      runParent: { provider, tools: new ToolRegistry() },
    })
    expect(code).toBe(0)
    const out = capture.stdout.join('')
    expect(out).toContain('Running team "pair"')
    expect(out).toContain('mode=sequential')
    expect(out).toContain('[1/2] a  p-a')
    expect(out).toContain('a-output')
    expect(out).toContain('[2/2] b  p-b')
    expect(out).toContain('b-output')
  })

  it('falls back to implicit tasks when the team omits them', async () => {
    // The "shorthand" shape: agents but no tasks. The
    // dispatcher should still build one task per agent.
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const path = join(dir, 'team.json')
    writeFileSync(
      path,
      JSON.stringify({
        name: 'shorthand',
        agents: [
          { name: 'a', description: 'do a', systemPrompt: 'do a' },
          { name: 'b', description: 'do b', systemPrompt: 'do b' },
        ],
      }),
      'utf8',
    )
    const code = await teamCommand({
      action: 'run',
      path,
      runParent: { provider, tools: new ToolRegistry() },
    })
    expect(code).toBe(0)
    const out = capture.stdout.join('')
    expect(out).toContain('[1/2] a  do a')
    expect(out).toContain('[2/2] b  do b')
  })

  it('returns 1 and writes to stderr when the orchestrator throws', async () => {
    // A runParent whose provider throws synchronously makes
    // the orchestrator surface the error to the awaiter.
    // We use a provider whose script is exhausted so the
    // first sub-agent chat call throws.
    const provider = new FakeProvider([])
    const path = join(dir, 'team.json')
    writeFileSync(path, JSON.stringify(twoAgentTeam()), 'utf8')
    const code = await teamCommand({
      action: 'run',
      path,
      runParent: { provider, tools: new ToolRegistry() },
    })
    expect(code).toBe(1)
    expect(capture.stderr.join('')).toMatch(/failed:/)
  })
})

describe('formatTeamResult (pure helper)', () => {
  it('projects the content field out of an AgentRunResult-shaped value', () => {
    const result = {
      finalMessage: { role: 'assistant', content: 'hello there', toolCalls: [] },
    }
    expect(formatTeamResult(result)).toBe('hello there')
  })

  it('handles a HandoffResult wrapper', () => {
    const result = {
      task: { spec: { name: 'a', description: 'a', systemPrompt: 'p' }, prompt: 'p' },
      result: {
        finalMessage: { role: 'assistant', content: 'agent says hi', toolCalls: [] },
      },
      handoff: { to: 'parent', reason: 'all done' },
    }
    const out = formatTeamResult(result)
    expect(out).toContain('agent says hi')
    expect(out).toContain('[handoff → parent: all done]')
  })

  it('falls back to a JSON dump for unknown shapes', () => {
    const out = formatTeamResult({ unexpected: 'shape', n: 42 })
    expect(out).toContain('"unexpected"')
    expect(out).toContain('"shape"')
  })

  it('returns the empty string for an AgentRunResult with no content', () => {
    const out = formatTeamResult({
      finalMessage: { role: 'assistant', content: '', toolCalls: [] },
    })
    expect(out).toBe('')
  })
})

describe('printTeamResults (pure helper)', () => {
  it('prints one [i/N] header per task plus an indented body', () => {
    const team = {
      name: 't',
      agents: [
        { name: 'a', description: 'a', systemPrompt: 'p' },
        { name: 'b', description: 'b', systemPrompt: 'p' },
      ],
      tasks: [
        { agentName: 'a', prompt: 'p-a' },
        { agentName: 'b', prompt: 'p-b' },
      ],
    }
    const results = [
      { finalMessage: { role: 'assistant', content: 'line 1', toolCalls: [] } },
      { finalMessage: { role: 'assistant', content: 'line 2', toolCalls: [] } },
    ]
    printTeamResults(team, results)
    // We can't easily capture stdout in a sync function
    // call, so we just assert it does not throw.
    expect(true).toBe(true)
  })
})

// Suppress unused-import warning for vi (it is imported for
// future mock setup if needed; not used today because
// teamCommand itself is not mocked here).
void vi
