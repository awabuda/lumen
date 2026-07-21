/**
 * SubAgentMiddleware (P19.3.3) — deepagents-style sub-agent dispatch.
 *
 * The middleware owns a registry of named `SubAgentSpec` instances and
 * a stub `task` tool. When the parent agent emits a tool call whose
 * name is `task`, `wrapToolCall` intercepts the dispatch, looks up the
 * referenced sub-agent by `subagent` field, and substitutes the
 * sub-agent's run for the original tool call. Other tool calls flow
 * through to the registered tool registry unchanged.
 */

import { z } from 'zod'
import type { BaseProvider } from '../../message/provider.js'
import { BaseTool, type ToolContext, type ToolRisk } from '../../tools/index.js'
import type { AgentMiddleware } from '../middleware.js'
import { createHandoffSubAgent } from '../sub-agent-handoff.js'
import { type SubAgentSpec, SubAgentSpecSchema, createSubAgentFromSpec } from '../sub-agent.js'

/** Stable tool name for the sub-agent dispatch tool. */
export const SUB_AGENT_TOOL_NAME = 'task' as const

/** Options for {@link createSubAgentMiddleware}. */
export interface SubAgentMiddlewareOptions {
  /** Parent agent config used to spawn sub-agents. */
  readonly parent: {
    readonly provider: BaseProvider
    readonly tools: import('../../tools/index.js').ToolRegistry
    readonly model?: string
    readonly cwd?: string
    /**
     * P23.2 — the parent's middleware list. When present, spawned
     * sub-agents route through `createAgent` so the parent's
     * beforeModel / afterModel / wrapToolCall / state-injection
     * surface propagates to the child agent. Omitted = sub-agent
     * has no middleware (preserves pre-P23.2 behaviour).
     */
    readonly middleware?: ReadonlyArray<AgentMiddleware>
  }
  /** Named sub-agent specs available to the parent. */
  readonly specs: ReadonlyArray<SubAgentSpec>
  /** Optional per-call default max iterations. */
  readonly maxIterations?: number
  /**
   * P19.4.3 — if true, the middleware routes sub-agent runs through
   * `createHandoffSubAgent` instead of the plain single-run factory.
   * The handoff stub tool is auto-registered into the sub-agent's
   * tool registry, and any `handoff` tool call the sub-agent emits
   * is surfaced in the tool result so the parent can act on it.
   */
  readonly enableHandoff?: boolean
}

/** Internal state for the SubAgentMiddleware. */
export interface SubAgentMiddlewareState {
  readonly specNames: ReadonlyArray<string>
}

const SubAgentStateSchema = z
  .object({
    specNames: z.array(z.string()),
  })
  .strict()

/** Input schema for the `task` tool. */
export const TaskToolInputSchema = z
  .object({
    subagent: z.string().min(1),
    prompt: z.string().min(1),
  })
  .strict()

/** Risk level for the stub task tool. */
export const SUB_AGENT_TOOL_RISK: ToolRisk = 'safe'

/**
 * Stub `task` tool entry. The middleware intercepts calls before
 * they reach `execute`, so the stub is just a registry placeholder
 * that lets the parent see a real tool definition.
 */
export class SubAgentTaskTool extends BaseTool {
  public override readonly name = SUB_AGENT_TOOL_NAME
  public override readonly description =
    'Delegate a sub-task to a registered sub-agent. ' +
    'Provide the subagent name and a prompt describing the task.'
  public override readonly inputSchema = TaskToolInputSchema
  public override readonly risk = SUB_AGENT_TOOL_RISK
  public override readonly version = '0.1.0'

  protected async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    // This is normally never called: wrapToolCall replaces the
    // default dispatch when tool name === 'task'. The fallback
    // echoes the parsed input so the agent can recover if the
    // middleware is removed in a future version.
    return { ...(input as Record<string, unknown>) }
  }
}

/** Internal: parsed options consumed by the middleware. */
interface ParsedSubAgentOptions {
  readonly parent: SubAgentMiddlewareOptions['parent']
  readonly specs: ReadonlyArray<SubAgentSpec>
  readonly maxIterations: number
  readonly specByName: ReadonlyMap<string, SubAgentSpec>
  readonly enableHandoff: boolean
}

const parseOptions = (options: SubAgentMiddlewareOptions): ParsedSubAgentOptions => {
  const specs = options.specs.map((s) => SubAgentSpecSchema.parse(s))
  const names = new Set<string>()
  const specByName = new Map<string, SubAgentSpec>()
  for (const spec of specs) {
    if (names.has(spec.name)) {
      throw new Error(`SubAgentMiddleware: duplicate sub-agent name "${spec.name}"`)
    }
    names.add(spec.name)
    specByName.set(spec.name, spec)
  }
  return {
    parent: options.parent,
    specs,
    maxIterations: options.maxIterations ?? 10,
    specByName,
    enableHandoff: options.enableHandoff === true,
  }
}

const formatOutput = (text: string): string =>
  text.length > 0 ? text : '(sub-agent produced no text)'

/** Format a handoff payload as a parent-readable tool result suffix. */
const formatHandoff = (handoff: { to: string; reason: string }): string =>
  `\n[handoff: to=${handoff.to} reason=${JSON.stringify(handoff.reason)}]`

/** Create the SubAgentMiddleware instance. */
export const createSubAgentMiddleware = (
  options: SubAgentMiddlewareOptions,
): AgentMiddleware<SubAgentMiddlewareState> => {
  const parsed = parseOptions(options)

  return {
    name: 'subagent',
    stateSchema: SubAgentStateSchema,
    initialState: { specNames: parsed.specs.map((s) => s.name) },
    wrapToolCall: async (toolCall, defaultCall) => {
      if (toolCall.name !== SUB_AGENT_TOOL_NAME) {
        return defaultCall()
      }
      const parsedInput = TaskToolInputSchema.safeParse(toolCall.arguments)
      if (!parsedInput.success) {
        return {
          toolCallId: toolCall.id,
          isError: true,
          content: `task: invalid arguments: ${parsedInput.error.message}`,
        }
      }
      const spec = parsed.specByName.get(parsedInput.data.subagent)
      if (!spec) {
        const known = Array.from(parsed.specByName.keys()).join(', ')
        return {
          toolCallId: toolCall.id,
          isError: true,
          content: `task: unknown subagent "${parsedInput.data.subagent}". Known: [${known}]`,
        }
      }
      try {
        const parentConfig = {
          provider: parsed.parent.provider,
          tools: parsed.parent.tools,
          ...(parsed.parent.model ? { model: parsed.parent.model } : {}),
          ...(parsed.parent.cwd ? { cwd: parsed.parent.cwd } : {}),
        }
        // P23.2 — forward the parent's middleware list so spawned
        // sub-agents inherit the same middleware surface. Both the
        // plain and handoff paths consume the optional 5th arg.
        const parentMiddleware = parsed.parent.middleware
        if (parsed.enableHandoff) {
          const handoff = createHandoffSubAgent({
            parent: parentConfig,
            spec,
            prompt: parsedInput.data.prompt,
            maxIterations: parsed.maxIterations,
            parentMiddleware,
          })
          const handoffResult = await handoff.run()
          const text = formatOutput(handoffResult.result.finalMessage.content ?? '')
          const handoffSuffix = handoffResult.handoff ? formatHandoff(handoffResult.handoff) : ''
          return {
            toolCallId: toolCall.id,
            isError: false,
            content: `${text}${handoffSuffix}`,
          }
        }
        const runner = createSubAgentFromSpec(
          parentConfig,
          spec,
          parsedInput.data.prompt,
          parsed.maxIterations,
          parentMiddleware,
        )
        const result = await runner.run()
        return {
          toolCallId: toolCall.id,
          isError: false,
          content: formatOutput(result.finalMessage.content ?? ''),
        }
      } catch (err) {
        return {
          toolCallId: toolCall.id,
          isError: true,
          content: `task: sub-agent "${parsedInput.data.subagent}" failed: ${(err as Error).message ?? String(err)}`,
        }
      }
    },
  }
}

/** Backwards-friendly alias. */
export const SubAgentMiddleware = createSubAgentMiddleware
