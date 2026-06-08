/**
 * Chat — the Ink/React TUI component.
 *
 * State machine:
 *
 *   idle ──submit──▶ thinking ──stream-done──▶ done
 *     ▲                  │                       │
 *     │                  ▼                       │
 *     └────────────── error ◀── error ◀──────────┘
 *
 * Responsibilities:
 *   - Render message history (user + assistant)
 *   - Render streaming content with a Spinner while in flight
 *   - Render tool call chips (the agent loop calls tools; we show
 *     which one is running)
 *   - Capture user input and submit to the agent
 *   - Handle Ctrl+C to abort a run (AbortController)
 *
 * We keep the component small on purpose — all the heavy lifting
 * happens in {@link Agent}. The component is just a bridge.
 */
import type { BuiltAgent } from '../composition.js';
interface ChatProps {
    /** The fully-built agent (provider, tools, hooks, memory). */
    readonly built: BuiltAgent;
}
export declare function Chat({ built }: ChatProps): JSX.Element;
export {};
//# sourceMappingURL=Chat.d.ts.map