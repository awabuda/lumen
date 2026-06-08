import { describe, expect, it } from 'vitest'
import { Budget } from '../src/budget/index.js'
import { BudgetExceededError } from '../src/errors/index.js'

describe('Budget', () => {
  it('does not throw when within limits', () => {
    const b = new Budget({ tokens: 1000, costUsd: 0.5, timeMs: 60_000 })
    b.addTokens(100)
    b.addCost(0.1)
    expect(() => b.check()).not.toThrow()
  })

  it('throws when token limit is exceeded', () => {
    const b = new Budget({ tokens: 100 })
    b.addTokens(101)
    expect(() => b.check()).toThrow(BudgetExceededError)
  })

  it('throws when cost limit is exceeded', () => {
    const b = new Budget({ costUsd: 1.0 })
    b.addCost(1.5)
    expect(() => b.check()).toThrow(BudgetExceededError)
  })

  it('snapshot reflects current usage', () => {
    const b = new Budget({ tokens: 1000, costUsd: 5.0 })
    b.addTokens(250)
    b.addCost(1.25)
    const s = b.snapshot()
    expect(s.tokensUsed).toBe(250)
    expect(s.costUsedUsd).toBe(1.25)
  })
})
