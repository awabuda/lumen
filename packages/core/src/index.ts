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
export {
  AgentError,
  BudgetExceededError,
  MaxIterationsExceededError,
  ProviderError,
  ToolError,
  ToolValidationError,
  AbortError,
} from './errors/index.js'

// Message types
export {
  // value types
  Role,
  MessageSchema,
  TextPartSchema,
  ImagePartSchema,
  ToolCallSchema,
  ToolResultSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  SystemMessageSchema,
  type Message,
  type TextPart,
  type ImagePart,
  type ToolCall,
  type ToolResult,
  type AssistantMessage,
  type UserMessage,
  type ToolMessage,
  type SystemMessage,
  type ReasoningPart,
  // streaming
  type StreamEvent,
  type StreamOptions,
} from './message/index.js'

// Provider contract
export {
  BaseProvider,
  type ProviderCapabilities,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
} from './message/provider.js'

// Tool contract
export {
  BaseTool,
  ToolRegistry,
  type ToolDescriptor,
  type ToolContext,
  type ToolRisk,
} from './tools/index.js'

// Memory contract
export type {
  MemoryRecord,
  MemoryQuery,
  MemorySearchResult,
  SessionRecord,
  SessionMessage,
} from './memory/index.js'
export { BaseMemoryStore } from './memory/index.js'

// Hooks
export {
  HookRegistry,
  type Hook,
  type HookContext,
  type HookEvent,
} from './hooks/index.js'

// Budget
export { Budget, type BudgetState } from './budget/index.js'

// Agent
export { Agent, type AgentConfig, type AgentRunOptions, type AgentRunResult } from './agent/index.js'
