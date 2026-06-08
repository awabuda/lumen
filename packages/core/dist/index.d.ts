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
export { AgentError, BudgetExceededError, MaxIterationsExceededError, ProviderError, ToolError, ToolValidationError, AbortError, } from './errors/index.js';
export { Role, MessageSchema, TextPartSchema, ImagePartSchema, ToolCallSchema, ToolResultSchema, AssistantMessageSchema, UserMessageSchema, ToolMessageSchema, SystemMessageSchema, type Message, type TextPart, type ImagePart, type ToolCall, type ToolResult, type AssistantMessage, type UserMessage, type ToolMessage, type SystemMessage, type ReasoningPart, type StreamEvent, type StreamOptions, } from './message/index.js';
export { BaseProvider, type ProviderCapabilities, type ChatRequest, type ChatResponse, type EmbedRequest, type EmbedResponse, } from './message/provider.js';
export { BaseTool, ToolRegistry, type ToolDescriptor, type ToolContext, type ToolRisk, } from './tools/index.js';
export type { MemoryRecord, MemoryQuery, MemorySearchResult, SessionRecord, SessionMessage, } from './memory/index.js';
export { BaseMemoryStore } from './memory/index.js';
export { HookRegistry, type Hook, type HookContext, type HookEvent, } from './hooks/index.js';
export { Budget, type BudgetState } from './budget/index.js';
export { Agent, type AgentConfig, type AgentRunOptions, type AgentRunResult } from './agent/index.js';
//# sourceMappingURL=index.d.ts.map