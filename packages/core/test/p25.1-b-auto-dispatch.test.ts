/**
 * P25.1.B \u2014 auto-dispatch router (bug.md #38).
 *
 * Verifies the helper routers without spinning up an
 * agent loop. The agent-loop integration of
 * `createAutoDispatchMiddleware` is exercised by the
 * existing middleware tests; this file pins the router
 * contract.
 */

import { describe, expect, it } from 'vitest'

import {
  heuristicSubAgentRouter,
  nullRouter,
} from '../src/agent/middleware/auto-dispatch.js'

describe('P25.1.B \u2014 auto-dispatch routers', () => {
  it('nullRouter returns null for every input', () => {
    expect(nullRouter({ currentSubAgentId: undefined, toolName: 'web_browser', toolInput: {}, history: [] })).toBeNull()
    expect(nullRouter({ currentSubAgentId: 'parent', toolName: 'subagent_spawn', toolInput: { subagent_id: 'x' }, history: [] })).toBeNull()
  })

  it('heuristic router dispatches subagent_* tools to the embedded id', () => {
    const target = heuristicSubAgentRouter({
      currentSubAgentId: undefined,
      toolName: 'subagent_spawn',
      toolInput: { subagent_id: 'explore-1' },
      history: [],
    })
    expect(target).toBe('explore-1')
  })

  it('heuristic router keeps non-subagent calls in the parent', () => {
    expect(
      heuristicSubAgentRouter({
        currentSubAgentId: undefined,
        toolName: 'web_browser',
        toolInput: {},
        history: [],
      }),
    ).toBeNull()
  })

  it('heuristic router returns null when subagent_id is missing', () => {
    expect(
      heuristicSubAgentRouter({
        currentSubAgentId: undefined,
        toolName: 'subagent_spawn',
        toolInput: {},
        history: [],
      }),
    ).toBeNull()
  })

  it('heuristic router returns null when subagent_id is not a string', () => {
    expect(
      heuristicSubAgentRouter({
        currentSubAgentId: undefined,
        toolName: 'subagent_spawn',
        toolInput: { subagent_id: 42 },
        history: [],
      }),
    ).toBeNull()
  })

  it('heuristic router returns null when toolInput is null', () => {
    expect(
      heuristicSubAgentRouter({
        currentSubAgentId: undefined,
        toolName: 'subagent_spawn',
        toolInput: null,
        history: [],
      }),
    ).toBeNull()
  })
})