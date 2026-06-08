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
import { loadConfig } from '@lumen/config';
import { Agent, HookRegistry, ToolRegistry } from '@lumen/core';
import { OpenAICompatibleProvider } from '@lumen/llm';
import { createFilesystemTools } from '@lumen/tools';
/**
 * Read the Lumen config from disk + env, returning a fully validated
 * {@link LumenConfig}. CLI flags (when constructing {@link buildAgent})
 * are applied on top of this.
 */
export const loadCliConfig = async (configPath) => {
    return loadConfig({ projectPath: configPath });
};
/**
 * Build an {@link Agent} ready to run. This is the single place that
 * reads process.env.LUMEN_* style secrets and turns them into a real
 * Provider instance.
 */
export const buildAgent = async (options = {}) => {
    const config = await loadCliConfig(options.configPath);
    const cwd = options.cwd ?? process.cwd();
    // Resolve provider config: CLI flag > env > first entry in config
    const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.LUMEN_API_KEY ?? config.providers[0]?.apiKey ?? '';
    const baseUrl = options.baseUrl ??
        process.env.OPENAI_BASE_URL ??
        process.env.LUMEN_BASE_URL ??
        config.providers[0]?.baseUrl ??
        'https://api.openai.com/v1';
    const model = options.model ?? config.defaultModel ?? process.env.LUMEN_MODEL ?? 'gpt-4o-mini';
    const provider = new OpenAICompatibleProvider({
        id: 'openai',
        apiKey,
        baseUrl,
        defaultModel: model,
    });
    const tools = new ToolRegistry();
    if (!options.noTools) {
        for (const t of createFilesystemTools()) {
            tools.register(t);
        }
    }
    const hooks = new HookRegistry();
    const agent = new Agent({
        provider,
        tools,
        hooks,
        config,
        model,
        cwd,
    });
    return { agent, provider, tools, hooks, config, model };
};
//# sourceMappingURL=composition.js.map