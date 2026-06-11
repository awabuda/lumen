/**
 * `lumen run "<prompt>"` — single-shot CLI: run one prompt, print the
 * answer, exit. No TUI, no streaming, no interactivity. Designed for
 * scripts and one-off questions.
 *
 * Exit codes:
 *   0 — success
 *   1 — agent error (network, provider, validation)
 *   2 — configuration error (missing API key, etc.)
 *   130 — interrupted (SIGINT)
 */
export interface RunCommandOptions {
    prompt: string;
    model?: string;
    configPath?: string;
    cwd?: string;
    apiKey?: string;
    baseUrl?: string;
    noTools?: boolean;
    /** Skip wiring a memory store (defaults to in-memory SQLite at
     *  `~/.lumen/memory.db`). Tests pass `:memory:` for hermetic
     *  runs. */
    memoryPath?: string;
    noMemory?: boolean;
    /** Skip MCP server discovery + connection. */
    noMcp?: boolean;
}
export declare const runCommand: (options: RunCommandOptions) => Promise<number>;
//# sourceMappingURL=run.d.ts.map