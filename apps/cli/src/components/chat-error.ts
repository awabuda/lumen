/**
 * TUI-side classifier for agent-loop errors (P20.1.2).
 *
 * `lumen chat` runs `agent.streamRun()` inside a React/Ink TUI. The
 * stream re-throws after yielding an `error` event; the React `catch`
 * block needs to decide between two competing recovery strategies:
 *
 *   - **silently reset to idle** — the conservative behaviour
 *     pre-P20.1.2 used for *any* `AbortError`. This is correct for
 *     user-initiated aborts (Ctrl+C cancels the AbortController) and
 *     for the `pre-aborted` path the runtime throws when the signal
 *     is already set at run start.
 *
 *   - **surface the message in the turn log** — required for
 *     `createInterruptMiddleware` aborts, where the user *did not*
 *     ask for the run to stop. The TUI needs to show them which
 *     tool tripped the rule.
 *
 * `createInterruptMiddleware` always emits messages containing the
 * `interrupt:` token (see `packages/core/src/agent/middleware/interrupt.ts`).
 * Because the `AbortError` constructor wraps the reason as
 * `Agent run aborted: <reason>`, the token lives somewhere in the
 * middle of the final message; we match with `includes` rather than
 * `startsWith`. See `classifyChatError` for the exact rule.
 *
 * Why a pure helper and not an inline check in Chat.tsx:
 *   - The classifier is the *whole* behaviour change for P20.1.2;
 *     extracting it makes the diff obvious and unit-testable.
 *   - React/Ink render tests are noisy (see `chat-snapshot.test.tsx`,
 *     which is stale); a pure function is the cheapest place to pin
 *     the contract.
 *   - The classifier is small enough that a memoised React hook
 *     would be overkill.
 */

/** Result of classifying an agent-loop error for the TUI. */
export type ChatErrorRoute =
  /** The run was interrupted by middleware — show the message. */
  | { kind: 'interrupt'; message: string }
  /** The user (or some other AbortController signal) cancelled — silent reset. */
  | { kind: 'user-abort' }
  /** A non-Abort error — show the message. */
  | { kind: 'error'; message: string }

/** Classify an error caught from `agent.streamRun()`.
 *
 * Implementation notes:
 *
 *   - `AbortError` is the only Error subclass that core ships; it
 *     sets `this.name = 'AbortError'` and wraps the constructor
 *     argument as `Agent run aborted: <reason>`. So a
 *     `createInterruptMiddleware` throw with reason
 *     `interrupt: tool "X" requires approval` produces a message
 *     of `Agent run aborted: interrupt: tool "X" requires approval`.
 *     We match the `interrupt:` token anywhere in the message
 *     (rather than requiring it to be the prefix) so the
 *     classification survives the wrapper.
 *
 *   - Any other `AbortError` (e.g. `pre-aborted` thrown when the
 *     signal was set before the run started, or the user
 *     hit Ctrl+C to cancel an in-flight run) classifies as
 *     `user-abort` and the TUI silently resets — the conservative
 *     pre-P20.1.2 behaviour.
 *
 *   - Anything that is not an `AbortError` is rendered as a red
 *     error line in the turn log.
 */
export const classifyChatError = (err: unknown): ChatErrorRoute => {
  const isAbort = err instanceof Error && err.name === 'AbortError'
  const message = err instanceof Error ? err.message : String(err)
  if (isAbort) {
    if (message.includes('interrupt:')) {
      return { kind: 'interrupt', message }
    }
    return { kind: 'user-abort' }
  }
  return { kind: 'error', message }
}
