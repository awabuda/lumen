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
import { SqliteStore } from '@lumen/memory';
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
    /**
     * Override the SQLite memory database path. When omitted,
     * the default is `~/.lumen/memory.db` (the XDG-friendly
     * home-directory choice). Tests pass `:memory:` to keep
     * the database hermetic.
     */
    memoryPath?: string;
    /**
     * Skip wiring a memory store at all. The agent runs
     * ephemerally; every `lumen run` starts a fresh session.
     * Useful for one-off scripts and CI.
     */
    noMemory?: boolean;
}
export interface BuiltAgent {
    readonly agent: Agent;
    readonly provider: BaseProvider;
    readonly tools: ToolRegistry;
    readonly hooks: HookRegistry;
    readonly config: LumenConfig;
    readonly model: string;
    /**
     * The memory store the agent was wired with, or `undefined`
     * when the caller asked for `noMemory: true`. The
     * composition root owns the lifetime: the CLI's `run`/
     * `chat` commands must call `memory?.dispose()` after the
     * agent loop finishes.
     */
    readonly memory?: SqliteStore;
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