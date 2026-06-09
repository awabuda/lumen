/**
 * Resolve a sandbox from a config.
 *
 * Throws a typed error if the strategy name is unknown. We do not
 * silently fall back to `default` because an operator who asked
 * for `docker` and got `default` would have a worse day than
 * someone who got a clear error.
 */
export function resolveSandbox(config) {
    const factory = config.factories[config.strategy];
    if (!factory) {
        throw new Error(`Unknown shell sandbox strategy: "${config.strategy}". ` +
            `Registered: [${Object.keys(config.factories).join(', ')}]`);
    }
    return factory(config);
}
/**
 * Helper: capture a child process's `exit` and `error` events into the
 * sandbox result shape. Used by {@link DefaultSandbox} and any future
 * strategy that uses `child_process.spawn` under the hood.
 */
export async function awaitChild(child, signal) {
    return new Promise((resolve) => {
        const onAbort = () => {
            child.kill('SIGTERM');
        };
        if (signal.aborted) {
            onAbort();
        }
        else {
            signal.addEventListener('abort', onAbort, { once: true });
        }
        child.once('exit', (code, sig) => {
            signal.removeEventListener('abort', onAbort);
            resolve({ exitCode: code, signal: sig });
        });
        child.once('error', () => {
            signal.removeEventListener('abort', onAbort);
            // Spawn-time errors (ENOENT etc.) reach us as a null exit code and
            // a populated `signal` of `null` after `error` fires. This branch
            // is here so a transient spawn failure still resolves the
            // promise instead of hanging the agent.
            resolve({ exitCode: null, signal: null });
        });
    });
}
//# sourceMappingURL=sandbox.js.map