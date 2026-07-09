/**
 * Tests for the agent team module (P20.7.1).
 *
 * The module is the CLI-side dispatcher that turns a
 * `team.json` file into one of the four P19.3 / P19.4
 * orchestrators. The tests cover:
 *
 *   1. Schema validation (good input, missing fields, bad
 *      agent references, supervisor with no tasks, etc.).
 *   2. JSON loading (`loadTeam`) — file not found, invalid
 *      JSON, schema rejection.
 *   3. Orchestrator dispatch (`orchestrateTeam`) — each of
 *      the four modes produces a runner with the right id and
 *      (when run against a `FakeProvider`) the right number
 *      of results.
 *
 * Per the agent-team design basis
 * (`docs/P20.7-agent-team.md`), this module owns no new
 * core logic; the dispatch tests just prove the wiring is
 * right. Detailed semantics for each mode live in their own
 * core tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TeamConfigError,
  TeamSchema,
  listTeamAgents,
  loadTeam,
  orchestrateTeam,
  resolveTeamMode,
} from '../src/commands/team.js'
import { FakeProvider } from './fake-provider.js'

/** A valid minimal team with one agent and one task. */
const minimalTeam = () => ({
  name: 'mini',
  agents: [{ name: 'a', description: 'agent a', systemPrompt: 'do a' }],
  tasks: [{ agentName: 'a', prompt: 'p' }],
})

/** Two agents, two tasks. Enough to exercise the dispatch paths. */
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

describe('TeamSchema', () => {
  it('accepts a minimal team', () => {
    const r = TeamSchema.safeParse(minimalTeam())
    expect(r.success).toBe(true)
  })

  it('rejects a team with no agents', () => {
    const r = TeamSchema.safeParse({ name: 'empty', agents: [] })
    expect(r.success).toBe(false)
  })

  it('rejects a team whose task references an unknown agent', () => {
    const r = TeamSchema.safeParse({
      name: 'bad-ref',
      agents: [{ name: 'a', description: 'a', systemPrompt: 'a' }],
      tasks: [{ agentName: 'unknown', prompt: 'p' }],
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      // The superRefine error must mention the unknown agent
      // name AND the known agent name so the operator can
      // fix it in one read.
      const messages = r.error.issues.map((i) => i.message)
      expect(messages.some((m) => m.includes('unknown'))).toBe(true)
    }
  })

  it('rejects supervisor mode with no tasks', () => {
    const r = TeamSchema.safeParse({
      name: 'lonely-supervisor',
      mode: 'supervisor',
      agents: [{ name: 'a', description: 'a', systemPrompt: 'a' }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts an explicit mode', () => {
    for (const mode of ['sequential', 'parallel', 'handoff', 'supervisor']) {
      const r = TeamSchema.safeParse({
        ...twoAgentTeam(),
        mode,
      })
      // supervisor needs tasks; the twoAgentTeam helper
      // provides them, so all 4 modes parse cleanly.
      expect(r.success).toBe(true)
    }
  })

  it('rejects an unknown mode', () => {
    const r = TeamSchema.safeParse({ ...twoAgentTeam(), mode: 'graph' })
    expect(r.success).toBe(false)
  })

  it('rejects an empty team name', () => {
    const r = TeamSchema.safeParse({ ...minimalTeam(), name: '' })
    expect(r.success).toBe(false)
  })
})

describe('loadTeam', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-team-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads and parses a valid team file', async () => {
    const path = join(dir, 'team.json')
    writeFileSync(path, JSON.stringify(minimalTeam()), 'utf8')
    const team = await loadTeam(path)
    expect(team.name).toBe('mini')
    expect(team.agents).toHaveLength(1)
  })

  it('throws TeamConfigError when the file is missing', async () => {
    await expect(loadTeam(join(dir, 'missing.json'))).rejects.toBeInstanceOf(TeamConfigError)
  })

  it('throws TeamConfigError when the file is not JSON', async () => {
    const path = join(dir, 'broken.json')
    writeFileSync(path, 'not json at all', 'utf8')
    await expect(loadTeam(path)).rejects.toBeInstanceOf(TeamConfigError)
  })

  it('throws TeamConfigError when JSON does not match the schema', async () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, JSON.stringify({ name: 'x', agents: [] }), 'utf8')
    await expect(loadTeam(path)).rejects.toBeInstanceOf(TeamConfigError)
  })
})

describe('orchestrateTeam', () => {
  const parent = (provider: FakeProvider) => ({
    provider,
    tools: new ToolRegistry(),
  })

  it('returns a sequential runner with the right id', () => {
    const team = { ...twoAgentTeam(), mode: 'sequential' as const }
    const runner = orchestrateTeam(team, parent(new FakeProvider([])))
    expect(runner.id).toBe('team:pair:sequential')
  })

  it('runs two tasks in sequential mode', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const runner = orchestrateTeam({ ...twoAgentTeam(), mode: 'sequential' }, parent(provider))
    const out = await runner.run()
    expect(out).toHaveLength(2)
  })

  it('returns a parallel runner with the right id', () => {
    const team = { ...twoAgentTeam(), mode: 'parallel' as const }
    const runner = orchestrateTeam(team, parent(new FakeProvider([])))
    expect(runner.id).toBe('team:pair:parallel')
  })

  it('runs two tasks in parallel mode', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const runner = orchestrateTeam({ ...twoAgentTeam(), mode: 'parallel' }, parent(provider))
    const out = await runner.run()
    expect(out).toHaveLength(2)
  })

  it('returns a handoff runner with the right id and runs each task as its own handoff', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b', toolCalls: [] } },
    ])
    const runner = orchestrateTeam({ ...twoAgentTeam(), mode: 'handoff' }, parent(provider))
    expect(runner.id).toBe('team:pair:handoff')
    const out = await runner.run()
    // handoff mode returns one result per task (each is a
    // HandoffResult wrapper, not an AgentRunResult).
    expect(out).toHaveLength(2)
  })

  it('returns a supervisor runner with the right id', () => {
    // We do NOT call .run() here: the supervisor's judge
    // re-uses the parent provider, so running it would
    // require a scripted judge response interleaved with
    // the sub-agent responses. That is the orchestrator's
    // own test surface (see `packages/core/test/sub-agent-handoff.test.ts`),
    // not this dispatcher's. We assert the id + that the
    // dispatch returns a runner with the documented shape.
    const team = { ...twoAgentTeam(), mode: 'supervisor' as const }
    const runner = orchestrateTeam(team, parent(new FakeProvider([])))
    expect(runner.id).toBe('team:pair:supervisor')
    expect(typeof runner.run).toBe('function')
  })

  it('defaults to sequential mode when the team does not specify one', () => {
    const team = twoAgentTeam()
    ;(team as { mode?: string }).mode = undefined
    const runner = orchestrateTeam(team, parent(new FakeProvider([])))
    expect(runner.id).toBe('team:pair:sequential')
  })

  it('falls back to one task per agent when tasks is omitted', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'a-out', toolCalls: [] } },
      { message: { role: 'assistant', content: 'b-out', toolCalls: [] } },
    ])
    const team = {
      name: 'shorthand',
      agents: [
        { name: 'a', description: 'do a', systemPrompt: 'do a' },
        { name: 'b', description: 'do b', systemPrompt: 'do b' },
      ],
    }
    const runner = orchestrateTeam(team, parent(provider))
    const out = await runner.run()
    // Two agents, two implicit tasks, sequential mode →
    // two results.
    expect(out).toHaveLength(2)
  })
})

describe('resolveTeamMode', () => {
  it('returns the declared mode when present', () => {
    expect(resolveTeamMode({ ...twoAgentTeam(), mode: 'parallel' })).toBe('parallel')
  })
  it('returns "sequential" when the mode is omitted', () => {
    expect(resolveTeamMode(twoAgentTeam())).toBe('sequential')
  })
})

describe('listTeamAgents', () => {
  it('returns the agent roster in declaration order', () => {
    const team = twoAgentTeam()
    const agents = listTeamAgents(team)
    expect(agents.map((a) => a.name)).toEqual(['a', 'b'])
  })
})
