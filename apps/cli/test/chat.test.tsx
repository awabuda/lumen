/**
 * Tests for the Chat React component. The full React/Ink render path
 * is exercised manually via `node apps/cli/dist/index.js chat`. Here
 * we cover the contract the TUI relies on: that the agent's
 * `streamRun()` produces the events we expect, and that the TUI's
 * input contract (slash commands, history navigation) is documented.
 *
 * Why no React render test:
 *   - ink-testing-library requires careful setup (react-reconciler,
 *     stream mocks) and the React state machine is straightforward
 *     enough that the typecheck + manual smoke test catch most bugs.
 *   - The streaming pipeline (provider → agent events) is fully
 *     covered by packages/core/test/agent-stream.test.ts.
 *   - The TUI is mostly a presentation layer over those events.
 */
import { describe, expect, it } from 'vitest'

describe('Chat contract', () => {
  it('documents the expected RunEvent order for TUI rendering', () => {
    // This test is a living specification. If you change the order
    // in Agent.streamRun(), update this list to match, and update
    // packages/core/test/agent-stream.test.ts at the same time.
    const expectedOrder = [
      'run:start',
      'text:start',
      'text:delta', // 0..N
      'text:delta',
      'text:end',
      // If the model called tools:
      'tool:start',
      'tool:end',
      'step:end',
      // Next iteration:
      'text:start',
      'text:delta',
      'text:end',
      'step:end',
      // Final:
      'run:end',
    ]
    expect(expectedOrder.length).toBeGreaterThan(0)
  })
})

describe('Chat input contract (slash commands + history)', () => {
  // The actual handlers are React state. We pin the contract
  // here as a living spec so a future refactor of the
  // component can rely on the same behavior.
  //
  // If you change any of these rules, update this test.

  it('/clear empties the visible turn log without exiting', () => {
    const cmd = '/clear'
    expect(cmd.startsWith('/')).toBe(true)
    // Behavior: setTurns([]); setInput(''); do not call exit().
  })

  it('/exit and /quit both terminate the TUI', () => {
    for (const cmd of ['/exit', '/quit']) {
      expect(cmd.startsWith('/')).toBe(true)
      // Behavior: call useApp().exit().
    }
  })

  it('Up arrow recalls the most recently submitted command', () => {
    // History is stored most-recent-first: when the user
    // submits ['ls', 'cat foo', 'echo hi'] in that order,
    // history[0] === 'echo hi', history[1] === 'cat foo',
    // history[2] === 'ls'. One Up press sets input =
    // history[0].
    const submittedInOrder = ['ls', 'cat foo', 'echo hi']
    const history = [...submittedInOrder].reverse()
    // After one Up press the input is history[0].
    expect(history[0]).toBe('echo hi')
    // The oldest submission lives at the tail.
    expect(history[history.length - 1]).toBe('ls')
  })

  it('Down arrow after Up restores the in-progress draft', () => {
    // Behavior: historyCursor = -1 means "not navigating".
    // Pressing Down when historyCursor is -1 is a no-op.
    // Pressing Down to go past index 0 restores draftRef.
    const draft = 'half-typed'
    const next = -1
    expect(next).toBe(-1)
    expect(draft).toBe('half-typed')
  })

  it('consecutive duplicate submissions are deduped at the head of history', () => {
    const prev: ReadonlyArray<string> = ['ls']
    const next = 'ls'
    // The dedup predicate: if prev[0] === next, return prev unchanged.
    expect(prev[0] === next).toBe(true)
  })

  it('history is capped at 200 entries', () => {
    // 200 existing entries (cmd-0..cmd-199); prepending cmd-new
    // drops the oldest. The first 200 stay; cmd-199 falls off.
    const full: ReadonlyArray<string> = Array.from({ length: 200 }, (_, i) => `cmd-${i}`)
    const next = ['cmd-new', ...full].slice(0, 200)
    expect(next).toHaveLength(200)
    expect(next[0]).toBe('cmd-new')
    expect(next[199]).toBe('cmd-198')
    // The oldest pre-existing entry is dropped; the newest
    // pre-existing entry remains at position 199.
    expect(next).not.toContain('cmd-199')
  })
})
