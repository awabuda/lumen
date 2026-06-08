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
    readonly tokensUsed: number;
    readonly tokensLimit: number;
    readonly costUsedUsd: number;
    readonly costLimitUsd: number;
    readonly elapsedMs: number;
    readonly timeLimitMs: number;
}
export interface BudgetLimits {
    /** Total token budget. undefined = no token limit. */
    readonly tokens?: number;
    /** Total cost budget in USD. undefined = no cost limit. */
    readonly costUsd?: number;
    /** Wall-clock time limit in ms. undefined = no time limit. */
    readonly timeMs?: number;
}
export declare class Budget {
    private readonly limits;
    private tokensUsed;
    private costUsedUsd;
    private readonly startedAt;
    constructor(limits?: BudgetLimits);
    /** Add tokens to the used count. Call this after every provider response. */
    addTokens(n: number): void;
    /** Add cost in USD. */
    addCost(usd: number): void;
    /** Snapshot of current usage. */
    snapshot(): BudgetState;
    /** True if any limit is exceeded. Does not throw. */
    isExceeded(): boolean;
    /**
     * Check the budget. Throws {@link BudgetExceededError} if exceeded.
     * Pass `kind: 'tokens' | 'cost' | 'time'` to identify the dimension.
     */
    check(): void;
}
//# sourceMappingURL=index.d.ts.map