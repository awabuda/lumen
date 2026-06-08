/**
 * The composition root.
 *
 * Everything in the CLI eventually comes through this file. It is the ONE
 * place that knows about concrete implementations (OpenAICompatibleProvider,
 * SqliteMemoryStore, real tools). The agent runtime stays blissfully
 * unaware of these choices.
 *
 * Why centralize here:
 *   - Tests construct their own composition roots with fakes.
 *   - Production code composes real instances from config.
 *   - The rest of the codebase stays free of "if production, use X" branches.
 *
 * Public surface:
 *   - {@link buildAgent}: build a ready-to-run Agent from CLI flags + env.
 *   - {@link loadCliConfig}: load + merge config for the CLI.
 */
import { type LumenConfig } from '@lumen/config';
import { Agent, HookRegistry, type BaseProvider, ToolRegistry } from '@lumen/core';
export interface CliAgentOptions {
    /** Path to a config file (overrides lookup). */
    configPath?: string;
    /** Override the LLM model. */
    model?: string;
    /** Working directory for tool execution. */
    cwd?: string;
    /** Override the API key. */
    apiKey?: string;
    /** Override the API base URL. */
    baseUrl?: string;
    /** Disable filesystem tools (for testing or sandboxed use). */
    noTools?: boolean;
}
export interface BuiltAgent {
    readonly agent: Agent;
    readonly provider: BaseProvider;
    readonly tools: ToolRegistry;
    readonly hooks: HookRegistry;
    readonly config: LumenConfig;
    readonly model: string;
}
/**
 * Read the Lumen config from disk + env, returning a fully validated
 * {@link LumenConfig}. CLI flags (when constructing {@link buildAgent})
 * are applied on top of this.
 */
export declare const loadCliConfig: (configPath?: string) => Promise<LumenConfig>;
/**
 * Build an {@link Agent} ready to run. This is the single place that
 * reads process.env.LUMEN_* style secrets and turns them into a real
 * Provider instance.
 */
export declare const buildAgent: (options?: CliAgentOptions) => Promise<BuiltAgent>;
//# sourceMappingURL=composition.d.ts.map