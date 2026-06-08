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
const DEFAULT_LIMITS = {
    tokens: Number.POSITIVE_INFINITY,
    costUsd: Number.POSITIVE_INFINITY,
    timeMs: Number.POSITIVE_INFINITY,
};
export class Budget {
    limits;
    tokensUsed = 0;
    costUsedUsd = 0;
    startedAt;
    constructor(limits = {}) {
        this.limits = { ...DEFAULT_LIMITS, ...limits };
        this.startedAt = Date.now();
    }
    /** Add tokens to the used count. Call this after every provider response. */
    addTokens(n) {
        this.tokensUsed += n;
    }
    /** Add cost in USD. */
    addCost(usd) {
        this.costUsedUsd += usd;
    }
    /** Snapshot of current usage. */
    snapshot() {
        return {
            tokensUsed: this.tokensUsed,
            tokensLimit: this.limits.tokens,
            costUsedUsd: this.costUsedUsd,
            costLimitUsd: this.limits.costUsd,
            elapsedMs: Date.now() - this.startedAt,
            timeLimitMs: this.limits.timeMs,
        };
    }
    /** True if any limit is exceeded. Does not throw. */
    isExceeded() {
        return (this.tokensUsed > this.limits.tokens ||
            this.costUsedUsd > this.limits.costUsd ||
            Date.now() - this.startedAt > this.limits.timeMs);
    }
    /**
     * Check the budget. Throws {@link BudgetExceededError} if exceeded.
     * Pass `kind: 'tokens' | 'cost' | 'time'` to identify the dimension.
     */
    check() {
        if (this.tokensUsed > this.limits.tokens) {
            throw new BudgetExceededErrorCtor('tokens', this.limits.tokens, this.tokensUsed);
        }
        if (this.costUsedUsd > this.limits.costUsd) {
            throw new BudgetExceededErrorCtor('cost', this.limits.costUsd, this.costUsedUsd);
        }
        if (Date.now() - this.startedAt > this.limits.timeMs) {
            throw new BudgetExceededErrorCtor('time', this.limits.timeMs, Date.now() - this.startedAt);
        }
    }
}
// Imported here to avoid a circular dep with errors/index.ts in some setups.
// In practice, errors/index.ts has no deps so this is safe.
import { BudgetExceededError as BudgetExceededErrorCtor } from '../errors/index.js';
//# sourceMappingURL=index.js.map