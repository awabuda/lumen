/**
 * Tests for the TUI error classifier (P20.1.2).
 *
 * The classifier decides whether the React `catch` block in `Chat.tsx`
 * should (a) silently reset the TUI to idle (user-initiated abort), or
 * (b) surface the error message in the turn log (interrupt middleware
 * abort, or any non-AbortError).
 *
 * We exercise every branch with the *real* `AbortError` from
 * `@lumen/core` so the test catches any future change to how
 * `createInterruptMiddleware` constructs its abort (e.g. a
 * different message prefix, or a new error subclass).
 */
import { AbortError } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { classifyChatError } from '../src/components/chat-error.js'

describe('classifyChatError', () => {
  it('routes an AbortError from createInterruptMiddleware (tool-name rule) to "interrupt"', () => {
    // This is the exact shape `createInterruptMiddleware` produces
    // in `wrapToolCall` when a tool in the `toolNames` list is
    // about to dispatch. The `AbortError` constructor wraps the
    // reason as `Agent run aborted: <reason>`; the classifier
    // matches the `interrupt:` token in the middle.
    const err = new AbortError('interrupt: tool "write_file" requires approval')
    const route = classifyChatError(err)
    expect(route.kind).toBe('interrupt')
    if (route.kind === 'interrupt') {
      expect(route.message).toContain('interrupt:')
      expect(route.message).toContain('write_file')
    }
  })

  it('routes an AbortError from createInterruptMiddleware (onError rule) to "interrupt"', () => {
    // The `onError: true` rule fires when a tool dispatch itself
    // throws. The wrapper preserves the original error message
    // inside the `interrupt:` token, so the user sees both the
    // rule that fired and the underlying cause.
    const err = new AbortError('interrupt: tool "write_file" failed: EACCES')
    const route = classifyChatError(err)
    expect(route.kind).toBe('interrupt')
  })

  it('routes an AbortError from createInterruptMiddleware (maxIterations rule) to "interrupt"', () => {
    // The `maxIterations` rule fires in `beforeModel`, before the
    // provider is hit, with a slightly different message format.
    const err = new AbortError('interrupt: maxIterations reached at iteration 50')
    const route = classifyChatError(err)
    expect(route.kind).toBe('interrupt')
  })

  it('routes a user-initiated AbortError (pre-aborted) to "user-abort"', () => {
    // `streamRun` throws `new AbortError("pre-aborted")` when the
    // signal is already set at run start. The TUI should silently
    // reset — the user already cancelled before the run began,
    // so there is nothing to display.
    const err = new AbortError('pre-aborted')
    const route = classifyChatError(err)
    expect(route.kind).toBe('user-abort')
  })

  it('routes a user-initiated AbortError (Ctrl+C default reason) to "user-abort"', () => {
    // `AbortController.abort()` without a reason yields a generic
    // `AbortError` with `name === 'AbortError'` and the default
    // constructor reason. The TUI should silently reset.
    const err = new AbortError()
    const route = classifyChatError(err)
    expect(route.kind).toBe('user-abort')
  })

  it('routes a non-AbortError to "error"', () => {
    // Provider / tool / network errors. The TUI already showed
    // these in the turn log pre-P20.1.2; P20.1.2 keeps that
    // behaviour and just routes the new middleware case through
    // the same path.
    const err = new Error('network unreachable')
    const route = classifyChatError(err)
    expect(route.kind).toBe('error')
    if (route.kind === 'error') {
      expect(route.message).toBe('network unreachable')
    }
  })

  it('handles a non-Error throwable (string) by returning the "error" route', () => {
    // Defensive: a future runtime could in theory `throw "x"`.
    // The classifier should not crash on it.
    const route = classifyChatError('something broke')
    expect(route.kind).toBe('error')
    if (route.kind === 'error') {
      expect(route.message).toBe('something broke')
    }
  })

  it('handles a non-Error throwable (plain object) by stringifying', () => {
    const route = classifyChatError({ code: 500 })
    expect(route.kind).toBe('error')
    if (route.kind === 'error') {
      expect(route.message).toBe('[object Object]')
    }
  })

  it('does not confuse an error message that merely mentions the word "interrupt" with an interrupt rule', () => {
    // Negative test: the classifier must rely on the `interrupt:`
    // *token* (with the colon), not the bare word. A user error
    // like `Error: my interrupt handler crashed` should still
    // classify as a generic `error`, not trigger the
    // interrupt-render path.
    const err = new Error('my interrupt handler crashed')
    const route = classifyChatError(err)
    expect(route.kind).toBe('error')
  })
})
