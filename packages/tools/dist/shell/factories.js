import { DefaultSandbox } from './default-sandbox.js';
import { NoneSandbox } from './none-sandbox.js';
/** Built-in factories keyed by strategy name. */
export const DEFAULT_SANDBOX_FACTORIES = {
    default: (config) => new DefaultSandbox(config),
    none: (config) => new NoneSandbox(config),
};
/**
 * Return a new registry with one extra factory installed under
 * `name`. If a factory with that name already exists it is
 * **replaced**, so downstream code can override a default. This
 * is by design: an operator who really wants to swap `default`
 * for their own implementation should be able to.
 */
export function withSandboxFactory(base, name, factory) {
    return { ...base, [name]: factory };
}
/**
 * Convenience: take a partial config, fill in the defaults, and
 * return a fully-populated `ShellSandboxConfig` ready to hand to
 * a sandbox factory.
 */
export function defaultShellSandboxConfig(partial = {}) {
    return {
        strategy: partial.strategy ?? 'default',
        env: partial.env ?? {},
        timeoutMs: partial.timeoutMs ?? 30_000,
        maxOutputBytes: partial.maxOutputBytes ?? 1024 * 1024, // 1 MiB
        factories: partial.factories ?? DEFAULT_SANDBOX_FACTORIES,
    };
}
//# sourceMappingURL=factories.js.map