/**
 * P23.5 — checkpoint save failure logging (fix #7).
 *
 * Before P23.5:
 *   - `saveCheckpointBestEffort` had a `catch {}` block that
 *     silently swallowed checkpoint persistence failures. A user
 *     who came back after a crash had no way to tell whether the
 *     run crashed, the checkpoint save crashed, or both — the
 *     `in_progress` checkpoint would simply be missing.
 *
 * After P23.5:
 *   - The catch block logs via `BaseLogger.warn` with structured
 *     context (sessionId, iterations, outcome, error message,
 *     error name). The best-effort contract is preserved: the
 *     run result / original error is never replaced by a
 *     checkpoint failure.
 *   - All 4 call sites in Agent.run pass `this.logger` to the
 *     helper.
 *
 * Tests assert:
 *   - A checkpoint store that throws on `save()` produces a
 *     warn log with the structured context.
 *   - The agent run still succeeds (best-effort contract).
 *   - A checkpoint store that succeeds produces no warn log.
 */

import { describe, expect, it } from 'vitest'
import {
  type AgentCheckpoint,
  type BaseCheckpointStore,
  InMemoryCheckpointStore,
} from '../src/agent/checkpoint.js'
import { createAgent } from '../src/agent/factory.js'
import { BaseLogger } from '../src/logging/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

/** Recording logger for assertions. */
class RecordingLogger extends BaseLogger {
  public readonly id = 'recording'
  public readonly records: { level: string; msg: string; context?: Record<string, unknown> }[] = []

  public debug(msg: string, context?: Record<string, unknown>): void {
    this.records.push({ level: 'debug', msg, context })
  }

  public info(msg: string, context?: Record<string, unknown>): void {
    this.records.push({ level: 'info', msg, context })
  }

  public warn(msg: string, context?: Record<string, unknown>): void {
    this.records.push({ level: 'warn', msg, context })
  }

  public error(msg: string, context?: Record<string, unknown>): void {
    this.records.push({ level: 'error', msg, context })
  }

  public child(_bindings: Record<string, unknown>): BaseLogger {
    return this
  }
}

/**
 * Wrap an existing BaseCheckpointStore so every `save()` throws.
 * Lets us drive the failure path through saveCheckpointBestEffort
 * without reimplementing the full store interface.
 */
class ThrowingSaveStore implements BaseCheckpointStore {
  public readonly id = 'throwing'
  public readonly attempts = 0
  constructor(private readonly inner: BaseCheckpointStore) {}
  public async save(checkpoint: AgentCheckpoint): Promise<AgentCheckpoint> {
    throw new Error('disk full')
  }
  public async get(id: string): Promise<AgentCheckpoint | undefined> {
    return this.inner.get(id)
  }
  public async list(sessionId: string): Promise<ReadonlyArray<AgentCheckpoint>> {
    return this.inner.list(sessionId)
  }
  public async latestInProgress(options?: {
    readonly sessionId?: string
    readonly minCreatedAt?: number
  }): Promise<AgentCheckpoint | undefined> {
    return this.inner.latestInProgress(options)
  }
  public async delete(id: string): Promise<boolean> {
    return this.inner.delete(id)
  }
}

describe('P23.5 — checkpoint failure logging', () => {
  it('logs at warn level when checkpoint store.save throws (terminal success path)', async () => {
    const logger = new RecordingLogger()
    const store = new ThrowingSaveStore(new InMemoryCheckpointStore())
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      logger,
    })
    // Even though save() throws, the run must succeed (best-effort
    // contract). The store throws on every save, including the
    // terminal 'success' save.
    const result = await agent.run({
      userMessage: 'hi',
      checkpointStore: store,
    })
    expect(result.finalMessage.content).toBe('done')
    const warnings = logger.records.filter((r) => r.level === 'warn')
    expect(warnings.length).toBeGreaterThan(0)
    const cpWarnings = warnings.filter((w) => w.msg.includes('checkpoint save failed'))
    expect(cpWarnings.length).toBeGreaterThan(0)
    // The warning carries structured context.
    const last = cpWarnings[cpWarnings.length - 1]
    expect(last?.context).toMatchObject({
      outcome: 'success',
      error: 'disk full',
      errorName: 'Error',
    })
    expect(typeof last?.context?.sessionId).toBe('string')
    expect(typeof last?.context?.iterations).toBe('number')
  })

  it('logs at warn level when checkpoint store throws on error path', async () => {
    const logger = new RecordingLogger()
    const store = new ThrowingSaveStore(new InMemoryCheckpointStore())
    // Provider that throws on every call → the agent run throws.
    const provider = new FakeProvider([])
    provider.chat = async () => {
      throw new Error('provider exploded')
    }
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      logger,
    })
    await expect(agent.run({ userMessage: 'hi', checkpointStore: store })).rejects.toThrow(
      'provider exploded',
    )
    // Best-effort: the original error is preserved, not replaced.
    // The terminal 'error' save attempt also failed → a second
    // warn log lands.
    const cpWarnings = logger.records.filter(
      (r) => r.level === 'warn' && r.msg.includes('checkpoint save failed'),
    )
    expect(cpWarnings.length).toBeGreaterThan(0)
    const errorPathWarning = cpWarnings.find((w) => w.context?.outcome === 'error')
    expect(errorPathWarning).toBeDefined()
  })

  it('does not log when checkpoint save succeeds', async () => {
    const logger = new RecordingLogger()
    const store = new InMemoryCheckpointStore()
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      logger,
    })
    const result = await agent.run({
      userMessage: 'hi',
      checkpointStore: store,
    })
    expect(result.finalMessage.content).toBe('done')
    // InMemoryCheckpointStore never throws → no warn logs.
    const cpWarnings = logger.records.filter(
      (r) => r.level === 'warn' && r.msg.includes('checkpoint save failed'),
    )
    expect(cpWarnings).toHaveLength(0)
  })

  it('does not log when no checkpoint store is configured', async () => {
    // saveCheckpointBestEffort returns early when store is undefined
    // (no catch path). The logger should be silent.
    const logger = new RecordingLogger()
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      logger,
    })
    await agent.run({ userMessage: 'hi' })
    expect(logger.records.filter((r) => r.level === 'warn')).toHaveLength(0)
  })
})
