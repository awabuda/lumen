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
/**
 * Registry of hooks. Hooks are called in registration order.
 * Failures in one hook do not affect others.
 */
export class HookRegistry {
    hooks = [];
    nextId = 0;
    /** Register a hook. Returns an unregister function. */
    register(hook) {
        const id = this.nextId++;
        this.hooks.push({ id, hook });
        return () => {
            const idx = this.hooks.findIndex((h) => h.id === id);
            if (idx >= 0)
                this.hooks.splice(idx, 1);
        };
    }
    /** Dispatch an event to all hooks. Returns when all hooks have settled. */
    async dispatch(event, ctx) {
        // Snapshot in case a hook unregisters itself or another hook.
        const snapshot = [...this.hooks];
        for (const { hook } of snapshot) {
            try {
                await hook(event, ctx);
            }
            catch (err) {
                // Swallow — agent must be robust to hook bugs.
                // Production code should also log this.
                // eslint-disable-next-line no-console
                console.error('[lumen/hooks] hook threw:', err);
            }
        }
    }
    /** Number of registered hooks. */
    get size() {
        return this.hooks.length;
    }
}
//# sourceMappingURL=index.js.map