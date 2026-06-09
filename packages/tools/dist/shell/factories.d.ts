/**
 * Default factory registry for {@link ShellSandbox} strategies.
 *
 * The `terminal` tool resolves its sandbox via this registry. The
 * `default` and `none` strategies are registered here; downstream
 * packages (e.g. `lumen-tools-docker`) extend the registry at
 * composition time via {@link withSandboxFactory}.
 *
 * The registry is **immutable** at runtime: `withSandboxFactory`
 * returns a new object, it does not mutate the original. This makes
 * the configuration safe to share across concurrent tool instances.
 */
import type { ShellSandboxConfig, ShellSandboxFactory } from './sandbox.js';
/** Built-in factories keyed by strategy name. */
export declare const DEFAULT_SANDBOX_FACTORIES: Readonly<Record<string, ShellSandboxFactory>>;
/**
 * Return a new registry with one extra factory installed under
 * `name`. If a factory with that name already exists it is
 * **replaced**, so downstream code can override a default. This
 * is by design: an operator who really wants to swap `default`
 * for their own implementation should be able to.
 */
export declare function withSandboxFactory(base: Readonly<Record<string, ShellSandboxFactory>>, name: string, factory: ShellSandboxFactory): Record<string, ShellSandboxFactory>;
/**
 * Convenience: take a partial config, fill in the defaults, and
 * return a fully-populated `ShellSandboxConfig` ready to hand to
 * a sandbox factory.
 */
export declare function defaultShellSandboxConfig(partial?: Partial<ShellSandboxConfig>): ShellSandboxConfig;
//# sourceMappingURL=factories.d.ts.map