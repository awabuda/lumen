/**
 * Sub-agent delegation — lets a parent agent run focused sub-tasks.
 *
 * P19.3 refactor note:
 *   The old module exported `BaseSubAgent` + `SingleRunSubAgent`, an
 *   abstract class with one wrapper implementation. P19+ rule 14 says
 *   this pattern must be deleted: abstract classes need at least two
 *   non-wrapper implementations. Sub-agents are now plain interface
 *   contracts plus factory helpers that reuse Agent directly.
 */

import { z } from 'zod'

import { Agent } from '../index.js'
import { ToolRegistry } from '../tools/index.js'
import { createAgent } from './factory.js'
import type { AgentConfig, AgentRunOptions, AgentRunResult, RunEvent } from './index.js'
import type { AgentMiddleware } from './middleware.js'

/** Zod schema for {@link SubAgentOptions}. */
export const SubAgentOptionsSchema = z
  .object({
    /** The goal / task description. */
    goal: z.string().min(1),
    /** Maximum iterations. Defaults to 10. */
    maxIterations: z.number().int().positive().optional(),
    /** Restrict to these tool names. If omitted, all tools are available. */
    allowedTools: z.array(z.string()).optional(),
    /** System prompt override. */
    systemPrompt: z.string().optional(),
    /** Model to use. Defaults to parent's model. */
    model: z.string().optional(),
  })
  .strict()

/** Configuration for a one-shot sub-agent run. */
export type SubAgentOptions = z.input<typeof SubAgentOptionsSchema>

/** Deepagents-style reusable sub-agent spec. */
export const SubAgentSpecSchema = z
  .object({
    /** Stable name used by task routing. */
    name: z.string().min(1),
    /** Human-facing description of when to call this sub-agent. */
    description: z.string().min(1),
    /** System prompt for the spawned agent. */
    systemPrompt: z.string().min(1),
    /** Optional tool allow-list. Omitted means inherit all tools. */
    tools: z.array(z.string()).optional(),
    /** Optional model override. */
    model: z.string().optional(),
  })
  .strict()

/** Deepagents-style reusable sub-agent spec. */
export type SubAgentSpec = z.input<typeof SubAgentSpecSchema>

/** Runtime contract for a sub-agent runner. */
export interface SubAgentRunner {
  /** Stable identifier for the runner. */
  readonly id: string
  /** Run the sub-agent to completion. */
  run(): Promise<AgentRunResult>
  /** Stream the sub-agent's run, yielding events as they happen. */
  stream(): AsyncGenerator<RunEvent>
}

/** Default system prompt template for one-shot sub-agents. */
const SUB_AGENT_SYSTEM_PROMPT = (goal: string): string =>
  [
    'You are a focused sub-agent. Your only task is:',
    '',
    goal,
    '',
    'Work step by step. When you have completed the task,',
    'provide a clear summary of what you did and what you found.',
    'Do not ask clarifying questions — make your best judgment.',
  ].join('\n')

/** Build a new ToolRegistry containing only the named tools. */
const buildRestrictedRegistry = (
  source: ToolRegistry,
  allowed: ReadonlyArray<string>,
): ToolRegistry => {
  const restricted = new ToolRegistry()
  for (const name of allowed) {
    const tool = source.get(name)
    if (tool) restricted.register(tool)
  }
  return restricted
}

/** Build a one-shot sub-agent `Agent`. P23.2 — wires the parent's
 *  middleware list through `createAgent` so sub-agent runs inherit
 *  the same beforeModel / afterModel / wrapToolCall / state-injection
 *  surface the parent has. When `parentMiddleware` is undefined or
 *  empty, the result is identical to a plain `new Agent({...})`. */
const buildAgent = (
  parent: AgentConfig,
  goal: string,
  options: {
    readonly allowedTools?: ReadonlyArray<string>
    readonly systemPrompt?: string
    readonly model?: string
  },
  parentMiddleware?: ReadonlyArray<AgentMiddleware>,
): Agent => {
  const tools = options.allowedTools
    ? buildRestrictedRegistry(parent.tools, options.allowedTools)
    : parent.tools

  const baseConfig: AgentConfig = {
    ...parent,
    tools,
    model: options.model ?? parent.model,
    systemPrompt: options.systemPrompt ?? SUB_AGENT_SYSTEM_PROMPT(goal),
  }

  // P23.2: route through createAgent so the parent middleware list
  // (P19.0.3 symbol-keyed attachment) propagates to the child agent.
  // The factory validates duplicate names at construction time and
  // is a no-op when the list is empty, so this is a strict superset
  // of the previous `new Agent(...)` path.
  if (parentMiddleware && parentMiddleware.length > 0) {
    return createAgent({ ...baseConfig, middleware: parentMiddleware })
  }
  return new Agent(baseConfig)
}

/** Create a one-shot sub-agent runner from a parent config + options.
 *
 *  P23.2 — the optional `parentMiddleware` list is forwarded to
 *  {@link buildAgent} so sub-agent runs inherit the parent's
 *  middleware. When omitted, the sub-agent behaves exactly like the
 *  pre-P23.2 implementation (no middleware).
 */
export const createSubAgent = (
  parent: AgentConfig,
  options: SubAgentOptions,
  parentMiddleware?: ReadonlyArray<AgentMiddleware>,
): SubAgentRunner => {
  const parsed = SubAgentOptionsSchema.parse(options)
  const agent = buildAgent(
    parent,
    parsed.goal,
    {
      allowedTools: parsed.allowedTools,
      systemPrompt: parsed.systemPrompt,
      model: parsed.model,
    },
    parentMiddleware,
  )
  const runOptions: AgentRunOptions = {
    userMessage: parsed.goal,
    maxIterations: parsed.maxIterations ?? 10,
  }

  return {
    id: 'single',
    async run(): Promise<AgentRunResult> {
      return agent.run(runOptions)
    },
    async *stream(): AsyncGenerator<RunEvent> {
      yield* agent.streamRun(runOptions)
    },
  }
}

/** Create a one-shot sub-agent runner from a reusable spec + prompt.
 *
 *  P23.2 — the optional `parentMiddleware` list is forwarded so the
 *  spawned sub-agent inherits the parent's middleware surface
 *  (P19.0.3 symbol-keyed attachment). When omitted, the sub-agent
 *  behaves exactly like the pre-P23.2 implementation.
 */
export const createSubAgentFromSpec = (
  parent: AgentConfig,
  spec: SubAgentSpec,
  prompt: string,
  maxIterations = 10,
  parentMiddleware?: ReadonlyArray<AgentMiddleware>,
): SubAgentRunner => {
  const parsed = SubAgentSpecSchema.parse(spec)
  return createSubAgent(
    parent,
    {
      goal: prompt,
      maxIterations,
      allowedTools: parsed.tools,
      systemPrompt: parsed.systemPrompt,
      model: parsed.model,
    },
    parentMiddleware,
  )
}
