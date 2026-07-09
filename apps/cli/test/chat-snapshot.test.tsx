/**
 * Snapshot tests for the Chat TUI component.
 *
 * We render the Chat component with Ink's `render()`
 * and capture the last frame's text output. The
 * snapshots are stored in `__snapshots__/` and compared
 * on every run. If the TUI output changes unexpectedly,
 * the test fails and the operator can review the diff.
 *
 * P21 fix: the pre-P20.6.2 version of this file passed
 * `onSend: noop` as a prop. The Chat component's actual
 * signature takes `{ built: BuiltAgent }` (it builds
 * its own subscription to `built.agent.streamRun()`),
 *
 * If you intentionally change the idle frame, run
 * `pnpm --filter @lumen/cli exec vitest run
 *  test/chat-snapshot.test.tsx -u` to update the
 * snapshot, then review the diff in the snapshot file.
 *
 * These tests require `ink-testing-library` (dev dep).
 */

import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAgent } from '../src/composition.js'
import { Chat } from '../src/components/Chat.js'
import type { BuiltAgent } from '../src/composition.js'

let built: BuiltAgent

beforeEach(async () => {
  // Hermetic build: no network, no filesystem tools, no
  // persistent memory. The provider is constructed but
  // never called because the idle-state render does not
  // submit a prompt.
  built = await buildAgent({
    apiKey: 'test-key',
    baseUrl: 'http://127.0.0.1:1',
    noMemory: true,
    noTools: true,
    noMcp: true,
  })
})

afterEach(async () => {
  // Belt-and-braces: if a future test starts persisting
  // memory, dispose it. Today `noMemory: true` makes
  // this a no-op.
  await built.memory?.dispose().catch(() => {})
})

describe('Chat snapshot (idle state)', () => {
  it('renders the idle prompt', () => {
    const { lastFrame } = render(React.createElement(Chat, { built }))
    const text = lastFrame()
    expect(text).toMatchSnapshot()
  })
})

describe('Chat snapshot (after typing)', () => {
  it('renders the input with typed text', () => {
    const { stdin, lastFrame } = render(React.createElement(Chat, { built }))
    stdin.write('hello lumen')
    const text = lastFrame()
    expect(text).toMatchSnapshot()
  })
})
