/**
 * P23.12 — slash command tests.
 *
 * bug.md #69 (/loop), #70 (/init scaffold), #71 (/cost).
 * Tests the slash-command handlers in `components/slash-commands.ts`
 * without spinning up the full Ink renderer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __loopRegistryForTests,
  __resetSlashStateForTests,
  formatBudgetSnapshot,
  handleLoopSlash,
  initProjectAsAssistant,
} from '../src/components/slash-commands.js'

beforeEach(() => {
  __resetSlashStateForTests()
})

afterEach(() => {
  __resetSlashStateForTests()
})

describe('P23.12 — fix #71: /cost — formatBudgetSnapshot', () => {
  it('renders a "no runs yet" hint when the agent has no budget snapshot', () => {
    const fakeBuilt = {
      agent: { budgetSnapshot: () => undefined },
    } as never
    expect(formatBudgetSnapshot(fakeBuilt)).toMatch(/no runs yet/)
  })

  it('renders tokens / cost / time when budget snapshot is present', () => {
    const fakeBuilt = {
      agent: {
        budgetSnapshot: () => ({
          used: 1234,
          costUsdConsumed: () => 0.0042,
          timeMsConsumed: () => 1820,
        }),
      },
    } as never
    const out = formatBudgetSnapshot(fakeBuilt)
    expect(out).toContain('tokens=1234')
    expect(out).toContain('$0.0042')
    expect(out).toContain('time=1820ms')
  })
})

describe('P23.12 — fix #69: /loop — handleLoopSlash', () => {
  it('returns an error message when /loop is sent without arguments', async () => {
    const result = await handleLoopSlash('/loop')
    expect(result.message).toMatch(/usage: \/loop/)
    expect(result.entry).toBeUndefined()
  })

  it('parses a Nm interval (every N minutes)', async () => {
    const result = await handleLoopSlash('/loop 5m check disk space')
    expect(result.message).toMatch(/every 5m/)
    expect(result.message).toMatch(/check disk space/)
    expect(result.entry).toBeDefined()
    expect(result.entry?.intervalMs).toBe(5 * 60 * 1000)
    expect(__loopRegistryForTests().length).toBe(1)
  })

  it('parses the literal "hourly" interval', async () => {
    const result = await handleLoopSlash('/loop hourly remind to drink water')
    expect(result.message).toMatch(/every 1h/)
    expect(result.entry?.intervalMs).toBe(60 * 60 * 1000)
  })

  it('returns an error for unparseable intervals', async () => {
    const result = await handleLoopSlash('/loop fortnightly foo')
    expect(result.message).toMatch(/unsupported interval/)
    expect(result.entry).toBeUndefined()
  })

  it('emits a clearer message when given a cron expression (P24 follow-up)', async () => {
    const result = await handleLoopSlash('/loop "*/5 * * * *" check')
    expect(result.message).toMatch(/cron expressions/)
    expect(result.message).toMatch(/P24 follow-up/)
    expect(result.entry).toBeUndefined()
  })

  it('requires a prompt after the interval (and rejects lone "/loop 5m")', async () => {
    const result = await handleLoopSlash('/loop 5m')
    expect(result.message).toMatch(/expected .+ <interval> <prompt>/)
    expect(result.entry).toBeUndefined()
  })
})

describe('P23.12 — fix #70: /init — analyzeCurrentProject', () => {
  it('emits a Markdown factsheet from the current working directory', () => {
    const msg = initProjectAsAssistant()
    expect(msg.role).toBe('assistant')
    // The factsheet is a multi-line Markdown document; we just
    // check the shape rather than insisting on any particular
    // section header text (which can change between versions).
    expect(msg.content).toMatch(/factsheet from /)
    expect(msg.content).toMatch(/## Package manager/)
  })
})
