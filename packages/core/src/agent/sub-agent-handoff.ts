/**
 * Handoff and Supervisor sub-agent orchestration (P19.4).
 *
 * HandoffSubAgent wraps a sub-agent that can voluntarily hand control
 * back to a parent by emitting a tool call named 'handoff' with
 * `{ to: string, reason: string }`. HandoffSubAgent returns the
 * handoff payload alongside the final message so the parent can
 * resume orchestration.
 *
 * SupervisorSubAgent wraps a sequential sub-agent chain with a
 * lightweight judge model. After each task the supervisor emits
 * `continue | redo | abort`; `continue` advances, `redo` re-runs
 * the last task, and `abort` stops the chain. The judge is a
 * plain function, not an abstract class.
 */

import { z } from 'zod'

import type { AgentRunResult } from './index.js'
import { type SubAgentSpec, SubAgentSpecSchema, createSubAgentFromSpec } from './sub-agent.js'
import type { SubAgentRunner } from './sub-agent.js'
import { BaseTool, type ToolContext, ToolRegistry } from '../tools/index.js'

/** Stable tool name for the handoff dispatch tool. */
export const HANDOFF_TOOL_NAME = 'handoff' as const

/** Stable tool name for the supervisor decision tool. */
export const SUPERVISOR_TOOL_NAME = 'supervisor_decision' as const

/** Parsed payload of a `handoff` tool call. */
export const HandoffPayloadSchema = z
  .object({
    to: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict()

/** Input schema for the handoff stub tool. */
export const HandoffToolInputSchema = HandoffPayloadSchema

/** Risk level for the handoff stub tool. */
export const HANDOFF_TOOL_RISK = 'safe' as const

/** Supervisor verdict after each task. */
export const SupervisorDecisionSchema = z.enum(['continue', 'redo', 'abort'])
export type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>

/** Tool-call shaped supervisor decision. */
export const SupervisorDecisionToolInputSchema = z
  .object({
    decision: SupervisorDecisionSchema,
    reason: z.string().min(1),
  })
  .strict()

/** Outcome of a handoff sub-agent run. */
export interface HandoffResult {
  readonly task: { spec: SubAgentSpec; prompt: string }
  readonly result: AgentRunResult
  /** Set when the sub-agent emitted a `handoff` tool call before exiting. */
  readonly handoff?: { to: string; reason: string }
}

/** Options for {@link createHandoffSubAgent}. */
export interface HandoffSubAgentOptions {
  readonly parent: {
    readonly provider: import('../message/provider.js').BaseProvider
    readonly tools: import('../tools/index.js').ToolRegistry
    readonly model?: string
    readonly cwd?: string
  }
  readonly spec: SubAgentSpec
  readonly prompt: string
  readonly maxIterations?: number
}

const HandoffResultSchema = z.object({
  task: z.object({ spec: SubAgentSpecSchema, prompt: z.string() }),
  result: z.custom<AgentRunResult>(),
  handoff: HandoffPayloadSchema.optional(),
})

/**
 * Parse a `handoff` payload out of the run's message history.
 *
 * The sub-agent must emit a `handoff` tool call to hand control back
 * to the parent. We walk the assistant messages in order and return
 * the first parseable handoff payload. We scan the full history
 * (not just `finalMessage`) because the agent loop often continues
 * after a tool call and the handoff can land in any step.
 */
const findHandoff = (result: AgentRunResult): { to: string; reason: string } | undefined => {
  for (const message of result.messages) {
    if (message.role !== 'assistant') continue
    for (const toolCall of message.toolCalls) {
      if (toolCall.name !== HANDOFF_TOOL_NAME) continue
      const parsed = HandoffPayloadSchema.safeParse(toolCall.arguments)
      if (parsed.success) return parsed.data
    }
  }
  return undefined
}

/** Handoff sub-agent runner contract (no stream; uses run-only). */
export interface HandoffSubAgentRunner {
  readonly id: string
  run(): Promise<HandoffResult>
}

/** Create a sub-agent that can hand control back to a parent. */
export const createHandoffSubAgent = (
  options: HandoffSubAgentOptions,
): HandoffSubAgentRunner => {
  const spec = SubAgentSpecSchema.parse(options.spec)
  const parent = options.parent
  const maxIterations = options.maxIterations ?? 10

  return {
    id: `handoff:${spec.name}`,
    async run(): Promise<HandoffResult> {
      const parentConfig: {
        provider: HandoffSubAgentOptions['parent']['provider']
        tools: HandoffSubAgentOptions['parent']['tools']
        model?: string
        cwd?: string
      } = {
        provider: parent.provider,
        tools: withAddedTool(parent.tools, new HandoffStubTool()),
      }
      if (parent.model !== undefined) parentConfig.model = parent.model
      if (parent.cwd !== undefined) parentConfig.cwd = parent.cwd
      const runner = createSubAgentFromSpec(
        parentConfig,
        spec,
        options.prompt,
        maxIterations,
      )
      const result = await runner.run()
      return { task: { spec, prompt: options.prompt }, result, handoff: findHandoff(result) }
    },
  }
}

/** Internal helper exposed for testing. */
export const extractHandoff = findHandoff
export { HandoffResultSchema }

/**
 * Stub tool: a sub-agent calls this to hand control back to a parent.
 * Returning the parsed payload (rather than just a sentinel) lets
 * callers see the `to` / `reason` directly in tool history if they
 * want to read it before `extractHandoff`.
 */
class HandoffStubTool extends BaseTool {
  public readonly name = HANDOFF_TOOL_NAME
  public readonly description = 'Hand control back to the parent agent.'
  public readonly inputSchema = HandoffToolInputSchema
  public readonly risk = HANDOFF_TOOL_RISK

  protected override async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    // Stub: real return path is the HandoffResult surfaced to the parent.
    return input
  }
}

/** Clone a parent's ToolRegistry and add a tool under a stable name. */
const withAddedTool = (source: ToolRegistry, tool: BaseTool): ToolRegistry => {
  const next = new ToolRegistry()
  for (const name of source.names()) {
    const existing = source.get(name)
    if (existing) next.register(existing)
  }
  next.register(tool)
  return next
}

/** Options for {@link createSupervisorSubAgent}. */
export interface SupervisorSubAgentOptions {
  readonly parent: {
    readonly provider: import('../message/provider.js').BaseProvider
    readonly tools: import('../tools/index.js').ToolRegistry
    readonly model?: string
    readonly cwd?: string
  }
  readonly tasks: ReadonlyArray<{ spec: SubAgentSpec; prompt: string }>
  readonly maxIterations?: number
  /** Per-task max iterations for sub-agents. */
  readonly subMaxIterations?: number
  /**
   * Judge provider. If omitted, the parent provider is reused.
   * The judge emits `supervisor_decision` tool calls to declare
   * `continue` / `redo` / `abort`.
   */
  readonly judgeProvider?: import('../message/provider.js').BaseProvider
  readonly judgeModel?: string
}

/** Internal mutable entry used while building the supervisor result. */
interface MutableSupervisorRunResult {
  task: { spec: SubAgentSpec; prompt: string }
  result: AgentRunResult
  decision?: SupervisorDecision
  reason?: string
  aborted?: true
}

/** Frozen public view of one supervisor step. */
export interface SupervisorRunResult extends Readonly<MutableSupervisorRunResult> {}

const SupervisorRunResultSchema = z.object({
  task: z.object({ spec: SubAgentSpecSchema, prompt: z.string() }),
  result: z.custom<AgentRunResult>(),
  decision: SupervisorDecisionSchema.optional(),
  reason: z.string().optional(),
  aborted: z.literal(true).optional(),
})

/** Supervisor sub-agent runner contract. */
export interface SupervisorSubAgentRunner {
  readonly id: string
  run(): Promise<AgentRunResult>
}

/**
 * Ask the judge to evaluate the most recent task and emit a decision
 * via the `supervisor_decision` tool. Falls back to `continue` if the
 * judge returns no parseable decision.
 */
const judgeTask = async (
  judge: import('../message/provider.js').BaseProvider,
  model: string | undefined,
  recent: { result: AgentRunResult },
): Promise<SupervisorDecision> => {
  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a supervisor evaluating the most recent sub-agent ' +
        'result. Decide whether to continue, redo, or abort by emitting ' +
        'exactly one tool call named supervisor_decision with ' +
        '{ decision, reason }.',
    },
    {
      role: 'user' as const,
      content: [
        'Sub-agent result:',
        recent.result.finalMessage.content ?? '(no content)',
        '',
        `Decide: continue / redo / abort?`,
      ].join('\n'),
    },
  ]
  const response = await judge.chat({
    model: model ?? 'gpt-4o-mini',
    messages,
    temperature: 0,
  })
  const content = response.message.content ?? ''
  const parsed = SupervisorDecisionToolInputSchema.safeParse(
    extractDecisionFromText(content),
  )
  if (parsed.success) return parsed.data.decision
  return 'continue'
}

const extractDecisionFromText = (text: string): unknown => {
  const match = /\{[\s\S]*\}/m.exec(text)
  if (!match) return {}
  try {
    return JSON.parse(match[0])
  } catch {
    return {}
  }
}

/** Create a supervisor-driven sequential sub-agent chain. */
export const createSupervisorSubAgent = (
  options: SupervisorSubAgentOptions,
): SupervisorSubAgentRunner => {
  const tasks = options.tasks.map((t) => ({
    spec: SubAgentSpecSchema.parse(t.spec),
    prompt: t.prompt,
  }))

  return {
    id: 'supervisor',
    async run(): Promise<AgentRunResult> {
      const judge = options.judgeProvider ?? options.parent.provider
      const judgeModel = options.judgeModel ?? options.parent.model

      const collected: MutableSupervisorRunResult[] = []
      for (let i = 0; i < tasks.length; i += 1) {
        const task = tasks[i]
        if (!task) continue

        const parentConfig: {
          provider: SupervisorSubAgentOptions['parent']['provider']
          tools: SupervisorSubAgentOptions['parent']['tools']
          model?: string
          cwd?: string
        } = {
          provider: options.parent.provider,
          tools: options.parent.tools,
        }
        if (options.parent.model !== undefined) parentConfig.model = options.parent.model
        if (options.parent.cwd !== undefined) parentConfig.cwd = options.parent.cwd
        const runner = createSubAgentFromSpec(
          parentConfig,
          task.spec,
          task.prompt,
          options.subMaxIterations ?? options.maxIterations ?? 10,
        )
        const result = await runner.run()
        const decision = await judgeTask(judge, judgeModel, { result })
        const entry: MutableSupervisorRunResult = { task, result, decision }
        if (decision === 'abort') {
          entry.aborted = true
          entry.reason = 'supervisor aborted the chain'
          collected.push(entry)
          break
        }
        collected.push(entry)
        if (decision === 'redo') {
          const redoResult = await runner.run()
          collected.push({ task, result: redoResult, decision: 'continue' })
        }
      }

      const last = collected[collected.length - 1]
      if (!last) {
        throw new Error('supervisor sub-agent chain produced no results')
      }
      const messages = collected.flatMap((c) => [
        { role: 'system' as const, content: c.task.spec.systemPrompt },
        { role: 'user' as const, content: c.task.prompt },
        {
          role: 'assistant' as const,
          content: c.result.finalMessage.content ?? '',
          toolCalls: [],
        },
      ])
      return {
        sessionId: last.result.sessionId,
        finalMessage: {
          ...last.result.finalMessage,
          toolCalls: [],
        },
        iterations: last.result.iterations,
        messages,
      }
    },
  }
}

/** Backwards-friendly aliases. */
export const HandoffSubAgent = createHandoffSubAgent
export const SupervisorSubAgent = createSupervisorSubAgent

// Re-export the helper to keep the public surface discoverable.
export { SupervisorRunResultSchema }
