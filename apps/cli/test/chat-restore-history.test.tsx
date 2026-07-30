/**
 * P32.2 — End-to-end render-path test for the "reopen chat with
 * prior history" feature.
 *
 * The unit tests in `restore-turns.test.ts` cover the pure
 * messages→turns mapping; this file verifies the wiring into the
 * React/Ink layer through `Chat.tsx`'s mount-time useEffect, so
 * a regression that breaks the prop flow (e.g. dropping
 * `initialResumeFrom` from the React effect deps, or importing
 * the wrong helper) does not get caught by the pure tests alone.
 *
 * Setup mirrors `chat-snapshot.test.tsx`: an hermetic
 * `buildAgent` with `noMemory: true`, `noTools: true`,
 * `noMcp: true`, an unreachable base URL so the provider is
 * constructed but never called. The test only exercises the
 * mount-time render path; the `streamRun` path is not entered.
 */

import type { AgentCheckpoint } from '@lumen/core'
import { InMemoryCheckpointStore } from '@lumen/core'
import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Chat } from '../src/components/Chat.js'
import { buildAgent } from '../src/composition.js'
import type { BuiltAgent } from '../src/composition.js'

// P32.2 mounts a useEffect that calls setTurns synchronously inside
// the effect body. ink-testing-library's lastFrame() returns the
// last *rendered* frame, but useEffect runs *after* render in
// microtask order, so calling lastFrame() right after render can
// capture the initial empty-turns state. The deterministic fix is
// to yield to the microtask queue once before sampling the frame;
// on the second frame the effect has settled and the restored
// turns are visible.
const flushEffects = async (): Promise<void> => await new Promise<void>((r) => setImmediate(r))

let built: BuiltAgent

beforeEach(async () => {
  built = await buildAgent({
    apiKey: 'sk-test-no-network',
    baseUrl: 'http://127.0.0.1:1',
    noMemory: true,
    noTools: true,
    noMcp: true,
  })
})

afterEach(async () => {
  await built.memory?.dispose().catch(() => {})
})

const cp = (messages: AgentCheckpoint['messages']): AgentCheckpoint => ({
  id: 'restore-test-1',
  sessionId: 'test-session',
  iterations: 1,
  createdAt: Date.now(),
  outcome: 'success',
  messages,
})

describe('Chat restore history (P32.2)', () => {
  it('renders prior user/assistant turns when initialResumeFrom is provided', async () => {
    const resumeFrom = cp([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer', toolCalls: [] },
    ])
    const { lastFrame } = render(
      React.createElement(Chat, {
        built,
        initialResumeFrom: resumeFrom,
      }),
    )
    await flushEffects()
    const text = lastFrame()
    expect(text).toContain('first question')
    expect(text).toContain('first answer')
  })

  it('renders nothing when initialResumeFrom is undefined', async () => {
    const { lastFrame } = render(React.createElement(Chat, { built }))
    await flushEffects()
    const text = lastFrame()
    // The idle prompt placeholder is rendered, but no user/assistant
    // bubbles (no historical turn content).
    expect(text).not.toContain('first question')
    expect(text).not.toContain('first answer')
  })

  it('keeps an in-progress tail user message visible without an assistant bubble', async () => {
    // P32.2 rule 4 — a checkpoint written during an interrupted
    // run often ends with a user message that has no assistant
    // reply yet. The TUI must still render that user bubble
    // (otherwise the resumed conversation would not show what
    // the user had typed before the interruption).
    const resumeFrom: AgentCheckpoint = {
      id: 'restore-test-2',
      sessionId: 'test-session',
      iterations: 1,
      createdAt: Date.now(),
      outcome: 'in_progress',
      messages: [{ role: 'user', content: 'half-typed question' }],
    }
    const { lastFrame } = render(
      React.createElement(Chat, {
        built,
        initialResumeFrom: resumeFrom,
      }),
    )
    await flushEffects()
    const text = lastFrame()
    expect(text).toContain('half-typed question')
  })

  it('renders a leading assistant message as an empty-user turn (rule 5)', async () => {
    // Some models (or test fixtures) start with a greeting as
    // the first assistant message. The TUI must still render
    // that greeting even though there is no preceding user.
    const resumeFrom = cp([{ role: 'assistant', content: 'opening greeting', toolCalls: [] }])
    const { lastFrame } = render(
      React.createElement(Chat, {
        built,
        initialResumeFrom: resumeFrom,
      }),
    )
    await flushEffects()
    expect(lastFrame()).toContain('opening greeting')
  })

  it('renders an in-memory checkpoint from BaseCheckpointStore consumers unchanged', async () => {
    // Sanity: chat-snapshot-style callers can still wire an
    // InMemoryCheckpointStore through Chat without crashing
    // the renderer, even though Chat currently does not call
    // save() in this test (mount-only render).
    const store = new InMemoryCheckpointStore()
    store
      .save(
        cp([
          { role: 'user', content: 'in-memory q' },
          { role: 'assistant', content: 'in-memory a', toolCalls: [] },
        ]),
      )
      .catch(() => {})
    const { lastFrame } = render(
      React.createElement(Chat, {
        built,
        checkpointStore: store,
        initialResumeFrom: cp([
          { role: 'user', content: 'wire-check q' },
          { role: 'assistant', content: 'wire-check a', toolCalls: [] },
        ]),
      }),
    )
    await flushEffects()
    expect(lastFrame()).toContain('wire-check q')
    expect(lastFrame()).toContain('wire-check a')
  })
})
