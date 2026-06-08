/**
 * The Ink TUI chat command. Loaded lazily by `src/index.ts` so that
 * users who only use `lumen run` don't pay the Ink/React startup cost.
 *
 * This file owns the **bridge** between the imperative agent runtime
 * (returns Promises / async iterators) and the declarative React/Ink
 * UI (driven by props + state). The bridge has three concerns:
 *
 *   1. Mount the React app under Ink.
 *   2. Build the {@link Agent} from CLI options before mounting.
 *   3. Translate the result of `agent.run()` (a single Promise) into
 *      a stream of UI events the React tree can consume.
 *
 * The React component itself is in `../components/Chat.jsx`. We keep
 * the JSX in a separate file so this file can stay pure TypeScript.
 */
export interface ChatCommandOptions {
    model?: string;
    configPath?: string;
    cwd?: string;
}
export declare const chatCommand: (options: ChatCommandOptions) => Promise<number>;
//# sourceMappingURL=chat.d.ts.map