/**
 * P25.4 \u2014 Agent View (bug.md #50).
 *
 * Pure-function tests for \`snapshotAgentView\` +
 * \`formatAgentView\`. The CLI consumer (\`lumen view\`)
 * is a future ticket; this file pins the data contract.
 */

import { describe, expect, it } from 'vitest'

import {
  formatAgentView,
  snapshotAgentView,
} from '../src/agent/view.js'
import type { BackgroundTaskRecord } from '../src/agent/background-tasks.js'

const taskRecord = (overrides: Partial<BackgroundTaskRecord<unknown>> = {}): BackgroundTaskRecord<unknown> => ({
  id: 't1',
  label: 'first',
  startedAtMs: 1_000,
  status: 'resolved',
  ...overrides,
})

describe('P25.4 \u2014 Agent View', () => {
  it('snapshot is a pure function with defensive copies', () => {
    const tasks: BackgroundTaskRecord<unknown>[] = [taskRecord()]
    const snap = snapshotAgentView({
      sessionId: 's',
      model: 'fake-model',
      startedAtMs: 0,
      iterations: 3,
      backgroundTasks: tasks,
      activeSubAgentIds: ['explore-1'],
      now: () => 1_000,
    })
    expect(snap.elapsedMs).toBe(1_000)
    expect(snap.iterations).toBe(3)
    expect(snap.backgroundTasks).toEqual(tasks)
    expect(snap.activeSubAgentIds).toEqual(['explore-1'])
    // Mutating the input array does NOT mutate the snapshot.
    tasks.push(taskRecord({ id: 't2' }))
    expect(snap.backgroundTasks).toHaveLength(1)
  })

  it('elapsedMs is non-negative even when now() < startedAtMs (clock skew)', () => {
    const snap = snapshotAgentView({
      sessionId: 's',
      model: 'fake-model',
      startedAtMs: 1000,
      iterations: 0,
      backgroundTasks: [],
      activeSubAgentIds: [],
      now: () => 500,
    })
    expect(snap.elapsedMs).toBe(0)
  })

  it('formatAgentView emits a one-line-per-row Markdown block', () => {
    const snap = snapshotAgentView({
      sessionId: 'session-123',
      model: 'gpt-4',
      startedAtMs: 0,
      iterations: 5,
      backgroundTasks: [taskRecord()],
      activeSubAgentIds: ['a', 'b'],
      now: () => 100,
    })
    const out = formatAgentView(snap)
    expect(out).toContain('session: session-123')
    expect(out).toContain('model: gpt-4')
    expect(out).toContain('iterations: 5')
    expect(out).toContain('background tasks: 1')
    expect(out).toContain('active sub-agents: 2')
  })
})