/**
 * Memory contract — the persistence boundary for the agent.
 *
 * The base interface is intentionally tiny. Implementations may be:
 *   - in-memory (for tests)
 *   - SQLite-backed (the default)
 *   - Redis, Postgres, or anything else
 *
 * The base contract is NOT a query DSL — it exposes a small set of methods
 * that cover 95% of agent needs. Specialised queries live in subclasses.
 *
 * The contract is also intentionally split into two concerns:
 *   1. {@link BaseMemoryStore} — durable records (facts, sessions)
 *   2. (future) Embedding index — separate, optional
 *
 * The agent uses both; subclasses can implement them in one class.
 */
/**
 * Abstract base for memory stores.
 *
 * Implementations MUST be safe to call from multiple async contexts
 * concurrently. The base contract does not promise transactions across
 * methods — if you need atomicity, expose a `transaction()` helper in a
 * subclass.
 */
export class BaseMemoryStore {
}
//# sourceMappingURL=index.js.map