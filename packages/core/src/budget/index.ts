/**
 * Budget — tracks and enforces resource consumption during an agent run.
 *
 * Three dimensions: tokens, cost (USD), wall-clock time. Any one being
 * exceeded raises {@link BudgetExceededError} on the next check.
 *
 * Why a class, not a function-bag: the budget is stateful (used so far,
 * per-kind), and we want all the enforcement in one place so the agent
 * loop can call `tick()` after every relevant event.
 */

export interface BudgetState {
  readonly tokensUsed: number
  readonly tokensLimit: number
  readonly costUsedUsd: number
  readonly costLimitUsd: number
  readonly elapsedMs: number
  readonly timeLimitMs: number
}

export interface BudgetLimits {
  /** Total token budget. undefined = no token limit. */
  readonly tokens?: number
  /** Total cost budget in USD. undefined = no cost limit. */
  readonly costUsd?: number
  /** Wall-clock time limit in ms. undefined = no time limit. */
  readonly timeMs?: number
}

const DEFAULT_LIMITS: Required<BudgetLimits> = {
  tokens: Number.POSITIVE_INFINITY,
  costUsd: Number.POSITIVE_INFINITY,
  timeMs: Number.POSITIVE_INFINITY,
}

export class Budget {
  private readonly limits: Required<BudgetLimits>
  private tokensUsed = 0
  private costUsedUsd = 0
  private readonly startedAt: number

  constructor(limits: BudgetLimits = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
    this.startedAt = Date.now()
  }

  /** Add tokens to the used count. Call this after every provider response. */
  public addTokens(n: number): void {
    this.tokensUsed += n
  }

  /** Add cost in USD. */
  public addCost(usd: number): void {
    this.costUsedUsd += usd
  }

  /** Snapshot of current usage. */
  public snapshot(): BudgetState {
    return {
      tokensUsed: this.tokensUsed,
      tokensLimit: this.limits.tokens,
      costUsedUsd: this.costUsedUsd,
      costLimitUsd: this.limits.costUsd,
      elapsedMs: Date.now() - this.startedAt,
      timeLimitMs: this.limits.timeMs,
    }
  }

  /**
   * P23.12 (fix #71) — quick-access token counter used by the
   * `/cost` slash command. The "used" half of the budget
   * name; the limit is exposed via {@link BudgetState.tokensLimit}.
   */
  public tokensConsumed(): number {
    return this.tokensUsed
  }

  /**
   * P23.12 (fix #71) — quick-access cost-in-USD counter used
   * by the `/cost` slash command.
   */
  public costUsdConsumed(): number {
    return this.costUsedUsd
  }

  /**
   * P23.12 (fix #71) — quick-access wall-clock elapsed counter
   * used by the `/cost` slash command.
   */
  public timeMsConsumed(): number {
    return Date.now() - this.startedAt
  }

  /**
   * P23.12 (fix #71) — alias for `snapshot().tokensUsed` kept
   * to make the `/cost` formatter read like an English
   * sentence. Existing callers (`Budget.used`) keep working.
   */
  public get used(): number {
    return this.tokensUsed
  }

  /** True if any limit is exceeded. Does not throw. */
  public isExceeded(): boolean {
    return (
      this.tokensUsed > this.limits.tokens ||
      this.costUsedUsd > this.limits.costUsd ||
      Date.now() - this.startedAt > this.limits.timeMs
    )
  }

  /**
   * Check the budget. Throws {@link BudgetExceededError} if exceeded.
   * Pass `kind: 'tokens' | 'cost' | 'time'` to identify the dimension.
   */
  public check(): void {
    if (this.tokensUsed > this.limits.tokens) {
      throw new BudgetExceededErrorCtor('tokens', this.limits.tokens, this.tokensUsed)
    }
    if (this.costUsedUsd > this.limits.costUsd) {
      throw new BudgetExceededErrorCtor('cost', this.limits.costUsd, this.costUsedUsd)
    }
    if (Date.now() - this.startedAt > this.limits.timeMs) {
      throw new BudgetExceededErrorCtor('time', this.limits.timeMs, Date.now() - this.startedAt)
    }
  }
}

// Imported here to avoid a circular dep with errors/index.ts in some setups.
// In practice, errors/index.ts has no deps so this is safe.
import { BudgetExceededError as BudgetExceededErrorCtor } from '../errors/index.js'
