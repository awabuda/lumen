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

// P23.11 (fix #72) — opt-in tool-call retry wrapper around
// `BaseTool.call(input, ctx)`. Pre-P23.11 retry semantics lived
// only at the Provider level (`withRetry`); tool-level transient
// failures did not retry. `callToolWithRetry` adds the same
// exponential-backoff-with-jitter surface to tool calls; the
// default `maxAttempts: 1` preserves back-compat for every
// existing call site.
export { callToolWithRetry, isRetryAborted } from './tool-retry.js'

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
  type LoopComputerAction,
  type LoopComputerUseModel,
  type ComputerUseStep,
  ComputerUseStepSchema,
  type ComputerUseLoopResult,
  type RunComputerUseLoopOptions,
  RunComputerUseLoopOptionsSchema,
  runComputerUseLoop,
} from './computer-use/loop.js'
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
  // P25.1 (bug.md #37) — sub-agent context isolation.
  SubAgentContextSchema,
  filterToSubAgent,
  createSubAgentContext,
  appendToSubAgent,
  memoSet,
  type User,
  type UserRole,
  type UserSession,
  type SubAgentContext,
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

// P31.1 — system prompt cache-boundary primitive (OpenClaw-style
// marker protocol; see `docs/P31-SYSTEM-PROMPT-DESIGN.md`).
// Re-exported here so downstream callers (P31.5 anthropic.ts,
// P31.6 Agent.run, P31.7 init template renderers) can reach
// the split/ensure/append helpers without diving into the
// agent/ subpath.
export {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  type BoundarySplit,
  appendDynamic,
  ensureSystemPromptCacheBoundary,
  findSystemPromptCacheBoundary,
  joinWithBoundary,
  splitByBoundary,
  stripBoundary,
} from './agent/system-prompt-boundary.js'

// P31.2 — layered prompt sections + PromptAssembler. Pure
// function `buildSystemPrompt(ctx)` is the single entry point
// for Agent.run (P31.6) and any caller that wants the
// canonical stable/dynamic split. R1 (no ToolRegistry schema
// dump) and R2/R3 (runtime + middleware chunks live in the
// dynamic suffix) are pinned by the test suite.
export {
  DEFAULT_BUDGET,
  DEFAULT_GUIDANCE_TEXT,
  KERNEL_TEXT,
  buildSystemPrompt,
  collectStableSections,
  renderSkillsIndex,
  renderStableText,
  type LayerBudgets,
  type ProfileLayers,
  type SectionContext,
  type SectionId,
  type SectionPayload,
  summarize,
  truncateSection,
} from './agent/system-prompt-sections.js'

// P31.3 — project + optional context-file loaders. Pure
// read-from-disk helpers wired through an `FsReader` shim
// so tests can drive them without touching the real
// filesystem. `loadProjectContext` covers P1 (AGENTS.md /
// CLAUDE.md walk-up), `loadOptionalContextFiles` covers
// P2 / B1 / M1.
export {
  type FsReader,
  type LoadedOptionalContext,
  type OptionalContextFilesOptions,
  type ProjectContextOptions,
  loadOptionalContextFiles,
  loadProjectContext,
} from './agent/system-prompt-loaders.js'

// P31.4 — LRU stable-prefix cache. Read-through wrapper
// around a SHA-256-keyed 64-slot LRU keyed on the stable
// subset of `SectionContext` (cwd / profile / layer
// texts); never indexes runtime or middleware dynamic
// chunks. Used by Agent.run (P31.6) to skip re-rendering
// the stable half on consecutive turns whose stable
// inputs are unchanged.
export {
  SYSTEM_PROMPT_CACHE_LRU_CAP,
  type LruStore,
  type StableCacheKey,
  StablePromptCache,
  createStablePromptLru,
  hashStableCacheKey,
} from './agent/system-prompt-cache.js'

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

// Checkpoint / Resume (P20.4) — agent run-state snapshots. The
// in-memory implementation is in core; a SQLite-backed store
// lives downstream in @lumen/memory (or apps/cli) so the core
// package can stay storage-agnostic.
export {
  AgentCheckpointSchema,
  InMemoryCheckpointStore,
  checkpointFromRun,
  type AgentCheckpoint,
  type BaseCheckpointStore,
  type CheckpointSessionSummary,
} from './agent/checkpoint.js'

// HITL interrupt middleware (P20.1) — declarative rules that
// throw AbortError when a tool name, max-iteration, or tool
// error matches. The P20.4.2 catch path in Agent.run then
// auto-saves a checkpoint so the caller can resume.
export {
  InterruptOptionsSchema,
  InterruptReasonSchema,
  createInterruptMiddleware,
  type InterruptOptions,
  type InterruptReason,
  type InterruptState,
  type InterruptApproveContext,
  type ApproveDecision,
} from './agent/middleware/interrupt.js'

// Permission policy middleware (P22) — static, deterministic
// tool-call gating. Three outcomes: `allow` short-circuits,
// `deny` throws a typed AbortError, `ask` falls through to
// the interrupt middleware. Sits in front of the interrupt
// layer in the composition order (alphabetical by `name`).
export {
  ToolPermissionDecisionSchema,
  ToolPermissionWhenSchema,
  ToolPermissionRuleSchema,
  ToolPermissionPolicySchema,
  ToolPermissionMiddlewareOptionsSchema,
  TOOL_PERMISSION_MAX_RULES,
  createStaticToolPermissionPolicy,
  createToolPermissionMiddleware,
  type ToolPermissionRule,
  type ToolPermissionPolicy,
  type ToolPermissionDecision,
  type BaseToolPermissionPolicy,
  type ToolPermissionDecisionRecord,
  type ToolPermissionState,
  type ToolPermissionMiddlewareOptions,
} from './agent/middleware/tool-permission.js'

export type { AutoModeRules as ToolPermissionAutoModeBlock } from './agent/middleware/auto-mode.js'

// Auto-mode classifier middleware (P22.5) — heuristic
// risk-tiered gating for low-risk tool calls. Sits between
// the static permission layer and the interrupt layer.
// `allow` short-circuits the interrupt chain (the operator's
// explicit opt-in via `autoMode: { enabled: true }`).
export {
  RiskTierSchema,
  RiskClassifierDecisionSchema,
  AutoModeRulesSchema,
  AutoModeMiddlewareOptionsSchema,
  DEFAULT_RISK_TABLE,
  createHeuristicRiskClassifier,
  createAutoModeMiddleware,
  type RiskTier,
  type RiskClassifierDecision,
  type AutoModeRules,
  type BaseRiskClassifier,
  type AutoModeDecisionRecord,
  type AutoModeState,
  type HeuristicRiskClassifierOptions,
  type AutoModeMiddlewareOptions,
} from './agent/middleware/auto-mode.js'

// Context compression middleware (P20.3) — collapse long
// message histories into a rolling summary before the model
// call. Defaults: maxMessages=20, keepLastN=10. Pass a custom
// summaryFn for LLM-backed summarisation; the default is a
// pure-function truncation (no API call).
export {
  ContextCompressionOptionsSchema,
  createContextCompressionMiddleware,
  type ContextCompressionOptions,
} from './agent/middleware/context-compression.js'

// Skill trigger middleware (P20.6) — lazy skill activation.
// The trigger function is supplied by the caller. The
// middleware just runs it on the latest user message and
// prepends a system-prompt augmentation listing the active
// skills. The core package does not import @lumen/skills
// to keep tier isolation; the caller typically uses the
// SkillRegistry's default shouldActivate scoring (see
// apps/cli/src/skill-trigger-adapter.ts for the CLI
// composition root).
export {
  ActiveSkillSchema,
  SkillTriggerOptionsSchema,
  createSkillTriggerMiddleware,
  type ActiveSkill,
  type SkillTriggerFn,
  type SkillTriggerOptions,
  type SkillTriggerState,
} from './agent/middleware/skill-trigger.js'

// Heartbeat / long-running supervisor (P20.2) — outer wrapper
// around Agent.run that aborts the run after `timeoutMs` of
// inactivity. Deliberately NOT a middleware: the supervisor
// runs between agent iterations and the agent loop has no
// "last activity" hook. A wrapper is the only honest place.
export {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  runWithHeartbeat,
  startHeartbeat,
  type HeartbeatHandle,
  type HeartbeatOptions,
} from './heartbeat.js'

// Observability — trace context (P20.8). Lightweight W3C-style
// trace propagation: 16-hex-char traceId + spanId, optional
// parentSpanId, optional name. `runWithTrace` is the documented
// entry point for trace-tagged scopes. A future P20.8.x ticket
// can add `createTraceHook(trace)` to wire the trace into Agent
// hook events without breaking the public surface.
export {
  createTrace,
  formatTrace,
  runWithTrace,
  type CreateTraceOptions,
  type TraceContext,
} from './trace.js'

// Dataset + scoring (P20.10) — structured benchmark harness.
// Sits on top of the existing apps/cli/test/perf/ harness;
// adds BenchmarkCase / BenchmarkScore types and a
// runDatasetBench helper that never throws (per-case errors
// are captured as failed score rows). Future P20.10.2 can
// rewrite the existing per-scenario benches in terms of
// runDatasetBench without changing the bench output format.
export {
  BenchmarkScoreSchema,
  reportTableRow,
  runDatasetBench,
  type BenchmarkCase,
  type BenchmarkReport,
  type BenchmarkScore,
  type RunDatasetBenchOptions,
} from './benchmark.js'
