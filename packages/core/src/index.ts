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
  AbortError,
  AgentError,
  BudgetExceededError,
  ConfigError,
  MaxIterationsExceededError,
  ProviderError,
  ToolError,
  ToolValidationError,
  ValidationError,
} from './errors/index.js'

// Retry helper (consumes ProviderError.retryable)
export {
  withRetry,
  RetryExhaustedError,
  RetryAbortedError,
  type RetryConfig,
} from './retry.js'

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
  createSubAgent,
  createSubAgentFromSpec,
  SubAgentOptionsSchema,
  SubAgentSpecSchema,
  type SubAgentOptions,
  type SubAgentSpec,
  type SubAgentRunner,
} from './agent/sub-agent.js'
export {
  createSequentialSubAgent,
  createParallelSubAgent,
  SequentialSubAgent,
  ParallelSubAgent,
  PARALLEL_DEFAULT_TIMEOUT_MS,
  SubAgentTaskSchema,
  TaskResultSchema,
  type SubAgentOrchestrator,
  type SubAgentOrchestratorOptions,
  type SubAgentTask,
  type SubAgentTaskResult,
} from './agent/sub-agent-orchestration.js'
export {
  createHandoffSubAgent,
  createSupervisorSubAgent,
  HandoffSubAgent,
  SupervisorSubAgent,
  HANDOFF_TOOL_NAME,
  HANDOFF_TOOL_RISK,
  HandoffPayloadSchema,
  HandoffToolInputSchema,
  SupervisorDecisionSchema,
  SupervisorDecisionToolInputSchema,
  HandoffResultSchema,
  SupervisorRunResultSchema,
  extractHandoff,
  type HandoffSubAgentOptions,
  type HandoffResult,
  type SupervisorSubAgentOptions,
  type SupervisorDecision,
  type SupervisorRunResult,
} from './agent/sub-agent-handoff.js'

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

// Per-provider circuit breaker (failure-rate gate, P9.4)
export {
  CircuitBreaker,
  CircuitBreakerOptionsSchema,
  CircuitOpenError,
  type CircuitBreakerOptions,
  type CircuitState,
} from './agent/circuit-breaker.js'

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
  StaticPlanner,
  LLMPlanner,
  createStaticPlanner,
  createLLMPlanner,
  revisePlan,
  extractPlanJson,
  parsePlanSteps,
  PlanStore,
  PlanSchema,
  PlanStepSchema,
  ModeSchema,
  type BasePlanner,
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

// createAgent factory (P19.0.3) — composition root's entry point.
// Sits alongside the Agent export so consumers can pick either
// the class or the factory. See packages/core/src/agent/factory.ts
// for the rationale (CLAUDE.md P19+ rule 13).
export {
  createAgent,
  getAgentMiddleware,
  AGENT_MIDDLEWARE,
  type CreateAgentConfig,
} from './agent/factory.js'

// Middleware 范式 spec (P19.0.1) — re-exported at the top of
// @lumen/core so downstream packages can `import { AgentMiddleware }
// from '@lumen/core'`. The factory above is the typical consumer.
export {
  type AgentMiddleware,
  type BeforeModelHook,
  type AfterModelHook,
  type WrapModelCall,
  type WrapToolCall,
  type MiddlewareContext,
  type MiddlewareControl,
  MiddlewareError,
  parseMiddleware,
  type ParsedMiddleware,
} from './agent/middleware.js'
export {
  createPlanMiddleware,
  PlanMiddleware,
  type PlanMiddlewareOptions,
  type PlanMiddlewareState,
} from './agent/middleware/plan.js'
export {
  createReflectionMiddleware,
  ReflectionMiddleware,
  ruleBasedReflectMessages,
  type ReflectionMiddlewareOptions,
  type ReflectionMiddlewareState,
  type ReflectionResult,
} from './agent/middleware/reflection.js'
export {
  createSubAgentMiddleware,
  SubAgentMiddleware,
  SubAgentTaskTool,
  SUB_AGENT_TOOL_NAME,
  SUB_AGENT_TOOL_RISK,
  TaskToolInputSchema,
  type SubAgentMiddlewareOptions,
  type SubAgentMiddlewareState,
} from './agent/middleware/sub-agent.js'

// Concurrency primitives (async mutex)
export {
  AcquireTimeoutError,
  BaseMutex,
  Mutex,
  MutexDisposedError,
  MutexOptionsSchema,
  type AcquireResult,
  type MutexOptions,
} from './concurrency/index.js'

// Bench quality scoring (P19.7.5) — rule-based second axis for
// performance reports. Kept in core (not in the bench files)
// so app-level tools can also call these helpers for ad-hoc
// quality reporting.
export {
  QualityScoresSchema,
  type QualityScores,
  planCoverageScore,
  reflectionConfidenceScore,
  subagentCoordinationScore,
  computeQualityScores,
  qualityTableCell,
} from './bench/quality.js'
