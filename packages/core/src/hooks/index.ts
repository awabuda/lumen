/**
 * Hook system — observer pattern for the agent lifecycle.
 *
 * Hooks are NOT a base contract you subclass. They're a function-based
 * subscription: register a callback, get notified on lifecycle events.
 *
 * Why function-based instead of class-based:
 *   - Hooks are usually 5-10 lines, often closures.
 *   - Class-based forces a name; function-based lets you compose.
 *   - Easier to add/remove dynamically.
 *
 * Hooks run sequentially in registration order. Errors in a hook are
 * caught and logged but do NOT abort the run (the agent must not be
 * fragile to a misbehaving observer).
 */

import type { AssistantMessage, Message, ToolCall, ToolResult } from '../message/index.js'

/** Lifecycle events the agent emits. */
export type HookEvent =
  | { kind: 'run:start'; sessionId: string; userMessage: string }
  | {
      kind: 'run:end'
      sessionId: string
      finalMessage: AssistantMessage
      iterations: number
      /**
       * P36 (bug.md #41 hooks lifecycle upgrade) — additive
       * cost metric. When the Agent finishes a run, we
       * surface the budget's total cost in this hook so
       * observers (logging, billing, /cost snapshots) can
       * read it without the budget being exposed
       * separately. Undefined when the run never built a
       * budget (e.g. threw before the first tool call).
       */
      costUsd?: number
      /** P36 — total tokens consumed across all model calls. */
      tokensUsed?: number
    }
  | { kind: 'step:start'; iteration: number }
  | { kind: 'step:end'; iteration: number; message: AssistantMessage }
  | { kind: 'message:append'; message: Message }
  | { kind: 'tool:call'; toolCall: ToolCall }
  | { kind: 'tool:result'; toolCall: ToolCall; result: ToolResult; durationMs: number }
  | { kind: 'error'; error: Error; recoverable: boolean }

/** Per-invocation context for hooks. */
export interface HookContext {
  readonly sessionId: string
  readonly iteration: number
  readonly startedAt: number
}

/** A single hook is a function that may return a Promise. */
export type Hook = (event: HookEvent, ctx: HookContext) => void | Promise<void>

/**
 * Registry of hooks. Hooks are called in registration order.
 * Failures in one hook do not affect others.
 */
import type { BaseLogger } from '../logging/index.js'

/** Options for {@link HookRegistry}. */
export interface HookRegistryOptions {
  /**
   * P23.10 (fix #46) — optional logger. When set, hook
   * exceptions are routed through `logger.error` instead of
   * `console.error`. The default behaviour (no logger) keeps
   * the previous `console.error` call so callers that never
   * thread a logger continue to see hook bugs.
   */
  readonly logger?: BaseLogger
}

export class HookRegistry {
  private readonly hooks: Array<{ id: number; hook: Hook }> = []
  private nextId = 0
  /** P23.10 (fix #46) — see {@link HookRegistryOptions}. */
  private readonly logger?: BaseLogger

  public constructor(options: HookRegistryOptions = {}) {
    // P23.10 (fix #46) — accept an optional logger. Without
    // an explicit constructor the default no-arg constructor
    // would silently drop `{ logger }`, leaving `this.logger`
    // always undefined and every dispatch falling back to
    // `console.error`.
    this.logger = options.logger
  }

  /** Register a hook. Returns an unregister function. */
  public register(hook: Hook): () => void {
    const id = this.nextId++
    this.hooks.push({ id, hook })
    return () => {
      const idx = this.hooks.findIndex((h) => h.id === id)
      if (idx >= 0) this.hooks.splice(idx, 1)
    }
  }

  /** Dispatch an event to all hooks. Returns when all hooks have settled. */
  public async dispatch(event: HookEvent, ctx: HookContext): Promise<void> {
    // Snapshot in case a hook unregisters itself or another hook.
    const snapshot = [...this.hooks]
    for (const { hook } of snapshot) {
      try {
        await hook(event, ctx)
      } catch (err) {
        // Swallow — agent must be robust to hook bugs.
        // P23.10 (fix #46) — route through the optional
        // logger so the error lands in agent.log rather than
        // the untraceable console.
        if (this.logger) {
          this.logger.error('hook threw', {
            error: err instanceof Error ? err.message : String(err),
            errorName: err instanceof Error ? err.name : 'UnknownError',
            hookEvent: event.kind,
          })
        } else {
          // eslint-disable-next-line no-console
          console.error('[lumen/hooks] hook threw:', err)
        }
      }
    }
  }

  /** Number of registered hooks. */
  public get size(): number {
    return this.hooks.length
  }
}
