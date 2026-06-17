/**
 * Snapshot tests for the Chat TUI component.
 *
 * We render the Chat component with Ink's `render()`
 * and capture the last frame's text output. The
 * snapshots are stored in `__snapshots__/` and compared
 * on every run. If the TUI output changes unexpectedly,
 * the test fails and the operator can review the diff.
 *
 * These tests require `ink-testing-library` (dev dep).
 */

import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Chat } from '../src/components/Chat.js'

// We render Chat with a no-op onSend so the component
// renders its idle state without making any agent calls.
const noop = async (): Promise<void> => {}

describe('Chat snapshot (idle state)', () => {
  it('renders the idle prompt', () => {
    const { lastFrame } = render(React.createElement(Chat, { onSend: noop }))
    const text = lastFrame()
    expect(text).toMatchSnapshot()
  })
})

describe('Chat snapshot (after typing)', () => {
  it('renders the input with typed text', () => {
    const { stdin, lastFrame } = render(React.createElement(Chat, { onSend: noop }))
    stdin.write('hello lumen')
    const text = lastFrame()
    expect(text).toMatchSnapshot()
  })
})
