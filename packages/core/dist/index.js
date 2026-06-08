/**
 * @lumen/core — the agent runtime.
 *
 * Core defines the contracts that every other package implements. It is
 * deliberately ignorant of concrete implementations: no provider URLs, no
 * tool names, no filesystem paths. You compose the runtime at the
 * composition root (typically the CLI) by passing concrete collaborators
 * into {@link Agent}.
 *
 * Public extension surfaces (in this package):
 *   - {@link BaseProvider}      (in `message/provider.ts`)
 *   - {@link BaseTool}          (in `tools/base.ts`)
 *   - {@link BaseMemoryStore}   (in `memory/base.ts`)
 *   - {@link Hook}              (in `hooks/base.ts`)
 *   - {@link Agent}             (in `agent/agent.ts`)
 *
 * Anything exported from those `base.ts` files is **stable** (semver-
 * protected). Other files are implementation detail and may move.
 */
// Errors
export { AgentError, BudgetExceededError, MaxIterationsExceededError, ProviderError, ToolError, ToolValidationError, AbortError, } from './errors/index.js';
// Message types
export { 
// value types
Role, MessageSchema, TextPartSchema, ImagePartSchema, ToolCallSchema, ToolResultSchema, AssistantMessageSchema, UserMessageSchema, ToolMessageSchema, SystemMessageSchema, } from './message/index.js';
// Provider contract
export { BaseProvider, } from './message/provider.js';
// Tool contract
export { BaseTool, ToolRegistry, } from './tools/index.js';
export { BaseMemoryStore } from './memory/index.js';
// Hooks
export { HookRegistry, } from './hooks/index.js';
// Budget
export { Budget } from './budget/index.js';
// Agent
export { Agent } from './agent/index.js';
//# sourceMappingURL=index.js.map