/**
 * Scenario 05: Memory persistence across runs.
 *
 * The test wires a real `SqliteStore` (`:memory:`-equivalent
 * via a temp file) into the Agent, runs one conversation,
 * then **disposes** the Agent and constructs a brand-new one
 * against the same SQLite file. The second run reads back
 * the persisted messages and asserts the agent loop
 * correctly wrote the user message, the assistant reply,
 * and (when tools are involved) the tool message.
 *
 * This catches:
 *   - SqliteStore + Agent wiring (the most common
 *     integration point) -- does appendMessage really
 *     get called for every role?
 *   - WAL vs `:memory:` semantics -- after dispose, does
 *     a fresh SqliteStore on the same file see the writes?
 *   - Schema migrations -- a fresh SqliteStore must
 *     recognise an existing schema and not re-create tables.
 *
 * The test deliberately does NOT depend on the model
 * "remembering" anything from the first run: that would
 * couple the test to a model's context-window behaviour
 * and produce flaky failures. We assert the persistence
 * layer directly, which is the actual contract.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent, ToolRegistry } from '@lumen/core'
import { SqliteStore } from '@lumen/memory'
import { describe, expect, it } from 'vitest'
import { e2eEnabled, getEnabledProviders } from './helpers.js'

const shouldRun = e2eEnabled() && getEnabledProviders().length > 0
const providers = getEnabledProviders()
const describeE2E = shouldRun ? describe : describe.skip

describeE2E('scenario 05: memory persistence across runs', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] persists and reloads a conversation from a SQLite file`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lumen-e2e-'))
      const dbPath = join(dir, 'memory.db')
      const sessionId = `e2e-${id}-${Date.now()}`

      try {
        // ---- Phase 1: write a conversation. ----
        const memoryA = new SqliteStore({ path: dbPath })
        await memoryA.init()
        const agentA = new Agent({
          provider,
          tools: new ToolRegistry(),
          memory: memoryA,
          model: defaultModel,
          systemPrompt: 'You are a precise assistant. Answer in one short sentence.',
        })
        const resultA = await agentA.run({
          userMessage: 'Say exactly: "lumen e2e ok".',
          sessionId,
        })
        await memoryA.dispose()

        // ---- Phase 2: read the same file with a fresh
        // SqliteStore and verify the messages came back. ----
        const memoryB = new SqliteStore({ path: dbPath })
        await memoryB.init()
        const messages = await memoryB.getSessionMessages(sessionId)
        await memoryB.dispose()

        // The session must exist and have at least two
        // messages (user + assistant).
        expect(messages.length).toBeGreaterThanOrEqual(2)
        const userMessages = messages.filter((m) => m.role === 'user')
        const assistantMessages = messages.filter((m) => m.role === 'assistant')
        expect(userMessages.length).toBeGreaterThanOrEqual(1)
        expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
        expect(userMessages[0]?.content).toContain('lumen e2e ok')

        // The first run's final content should match what
        // was persisted (modulo any model-side whitespace
        // normalisation).
        const finalA = resultA.finalMessage.content ?? ''
        const finalPersisted = assistantMessages[assistantMessages.length - 1]?.content ?? ''
        expect(finalPersisted.length).toBeGreaterThan(0)
        expect(finalA.length).toBeGreaterThan(0)
        // Don't compare strings character-for-character --
        // the model may have rephrased. We only assert
        // both are non-empty.
        expect(finalPersisted.toLowerCase()).toContain('lumen e2e ok')
      } finally {
        // Always clean up the temp directory. SqliteStore
        // opens the file in WAL mode, which leaves -wal
        // and -shm siblings; the recursive remove handles
        // those.
        rmSync(dir, { recursive: true, force: true })
      }
    }, 60_000)
  }
})
