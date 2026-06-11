/**
 * Configuration loader.
 *
 * Strategy: build a layered dict, lowest priority first, and shallow-merge
 * higher-priority on top. Object values are deep-merged with a hand-rolled
 * merger that respects arrays as atomic values (i.e. arrays are replaced, not
 * concatenated — that matches what users expect from YAML configs).
 *
 * Public API: {@link loadConfig}.
 */
import { type LumenConfig } from './schema.js';
export interface LoadConfigOptions {
    /** Path to a project config file. Overrides the default lookup. */
    projectPath?: string;
    /** Path to a user config file. Overrides the default. */
    userPath?: string;
    /** CLI flag overrides, applied with the highest precedence. */
    cliOverrides?: Record<string, unknown>;
    /** Environment variable prefix. Defaults to `LUMEN_`. */
    envPrefix?: string;
    /** Working directory for default project lookup. */
    cwd?: string;
    /** Skip loading the user config (useful in tests). */
    skipUserConfig?: boolean;
    /** Skip loading the project config. */
    skipProjectConfig?: boolean;
}
/** Deep merge plain objects. Arrays and other non-plain values are replaced. */
export declare const deepMerge: (base: Record<string, unknown>, override: Record<string, unknown>) => Record<string, unknown>;
export declare const loadConfig: (options?: LoadConfigOptions) => Promise<LumenConfig>;
//# sourceMappingURL=loader.d.ts.map