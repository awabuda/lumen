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
  ContentPartSchema,
  ToolCallSchema,
  ToolResultSchema,
  AssistantMessageSchema,
  UserMessageSchema,
  ToolMessageSchema,
  SystemMessageSchema,
  type Message,
  type TextPart,
  type ImagePart,
  type ContentPart,
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

// Tool contract (re-exported below in the unified Tools block)
// Memory contract
export type {
  MemoryRecord,
  MemoryQuery,
  MemorySearchResult,
  SessionRecord,
  SessionMessage,
} from './memory/index.js'
export { BaseMemoryStore, BaseVectorMemoryStore } from './memory/index.js'
export {
  BaseWorkingMemory,
  RingBufferWorkingMemory,
  renderWorkingMemory,
  type WorkingMemoryEntry,
} from './memory/working-memory.js'

// Hooks
export {
  HookRegistry,
  type Hook,
  type HookContext,
  type HookEvent,
} from './hooks/index.js'

// Tools (registry + base + toolset)
export {
  BaseTool,
  ToolRegistry,
  type ToolContext,
  type ToolDescriptor,
  type ToolRisk,
} from './tools/index.js'
export {
  BaseToolset,
  StaticToolset,
  LazyToolset,
  type ToolsetFactory,
} from './tools/toolset.js'

// Logging
export {
  BaseLogger,
  ConsoleLogger,
  PinoLogger,
  type LogEntry,
  type LogLevel,
} from './logging/index.js'

// Telemetry
export {
  BaseTelemetryBackend,
  NoopTelemetryBackend,
  ConsoleTelemetryBackend,
  TelemetryCollector,
  type TelemetryEvent,
} from './telemetry/index.js'

// Sub-agent delegation
export {
  BaseSubAgent,
  SingleRunSubAgent,
  createSubAgent,
  SubAgentOptionsSchema,
  type SubAgentOptions,
} from './agent/sub-agent.js'

// Provider pool (multi-backend routing + failover)
export {
  BaseProviderPool,
  ProviderPool,
  PoolExhaustedError,
  PooledProviderConfigSchema,
  ProviderPoolOptionsSchema,
  type RoutingStrategy,
  type CapabilityKey,
  type PooledProviderConfig,
  type ProviderPoolOptions,
} from './agent/pool.js'

// Cron scheduler
export {
  BaseCron,
  IntervalCron,
  OnceCron,
  CronExpressionCron,
  CronScheduler,
  cronMatches,
  BaseCronOptionsSchema,
  IntervalCronOptionsSchema,
  OnceCronOptionsSchema,
  CronExpressionCronOptionsSchema,
  type CronJob,
  type CronRun,
  type BaseCronOptions,
  type IntervalCronOptions,
  type OnceCronOptions,
  type CronExpressionCronOptions,
} from './cron/index.js'

// Plan/act mode
export {
  BasePlanner,
  StaticPlanner,
  LLMPlanner,
  PlanStore,
  PlanSchema,
  PlanStepSchema,
  ModeSchema,
  type Plan,
  type PlanStep,
  type Mode,
  type StaticPlannerOptions,
  type LLMPlannerOptions,
} from './plan/index.js'

// Multi-user collaboration
export {
  BasePermissionPolicy,
  BaseUserStore,
  RoleBasedPolicy,
  ApprovalRequiredPolicy,
  InMemoryUserStore,
  SessionGate,
  MultiUserRuntime,
  CreateUserInputSchema,
  UpdateUserInputSchema,
  UserRoleSchema,
  UserSessionSchema,
  type User,
  type UserRole,
  type UserSession,
  type PermissionDecision,
  type PermissionContext,
  type RoleBasedPolicyOptions,
  type InMemoryUserStoreOptions,
  type MultiUserRuntimeOptions,
} from './multi-user/index.js'

// Budget
export { Budget, type BudgetState } from './budget/index.js'

// Agent
export {
  Agent,
  type AgentConfig,
  type AgentRunOptions,
  type AgentRunResult,
  type RunEvent,
} from './agent/index.js'

// Concurrency primitives (async mutex)
export {
  AcquireTimeoutError,
  BaseMutex,
  Mutex,
  MutexOptionsSchema,
  type AcquireResult,
  type MutexOptions,
} from './concurrency/index.js'
