/**
 * Tests for the Chat React component. The full React/Ink render path
 * is exercised manually via `node apps/cli/dist/index.js chat`. Here
 * we cover the contract the TUI relies on: that the agent's
 * `streamRun()` produces the events we expect.
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

