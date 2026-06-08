/**
 * Stub for the Ink TUI chat command. The real implementation is in
 * `chat.tsx` and is loaded by the TUI command module.
 *
 * This stub exists so the import in `index.ts` resolves during early
 * development and tests. When the TUI module is ready, replace this
 * with a re-export.
 */
export interface ChatCommandOptions {
    model?: string;
    configPath?: string;
    cwd?: string;
}
export declare const chatCommand: (_options: ChatCommandOptions) => Promise<number>;
//# sourceMappingURL=chat.d.ts.map