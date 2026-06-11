/**
 * Sub-agent delegation — lets the main agent spawn focused
 * sub-tasks that run their own conversation loop.
 *
 * A {@link BaseSubAgent} wraps an {@link Agent} with a single
 * goal-driven run. Sub-agents share the parent's provider,
 * memory, and hooks, but can be restricted to a subset of
 * tools via {@link SubAgentOptions.allowedTools}.
 *
 * Why a wrapper, not a subclass of Agent:
 *   `Agent` is explicitly non-subclassable — see
 *   {@link Agent} JSDoc, "do NOT subclass Agent". Sub-agents
 *   don't change the loop, they reuse it.
 *
 * Security: sub-agents inherit the parent's tool registry
 * but can be restricted via `allowedTools`.
 */

import { z } from 'zod'

import { Agent } from '../index.js'
import type { AgentConfig, AgentRunOptions, AgentRunResult, RunEvent } from './index.js'
import { ToolRegistry } from '../tools/index.js'

/** Zod schema for {@link SubAgentOptions}. */
export const SubAgentOptionsSchema = z.object({
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

/**
 * Configuration for a sub-agent.
 *
 * `maxIterations` is optional in user input; the default
 * 10 is applied at construction time inside SingleRunSubAgent.
 */
export type SubAgentOptions = z.input<typeof SubAgentOptionsSchema>

/** Default system prompt template for sub-agents. */
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

/**
 * The contract every sub-agent implementation fulfills.
 *
 * Implementations extend Agent's loop via composition (a
 * held Agent instance), not via inheritance.
 */
export abstract class BaseSubAgent {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /**
   * Run the sub-agent to completion. Throws on failure —
   * callers must handle errors with try/catch (Rule 7).
   */
  public abstract run(): Promise<AgentRunResult>

  /** Stream the sub-agent's run, yielding events as they happen. */
  public abstract stream(): AsyncGenerator<RunEvent>
}

/**
 * The default sub-agent: wraps a single Agent instance
 * with a goal-driven run.
 */
export class SingleRunSubAgent extends BaseSubAgent {
  public readonly id = 'single'

  private readonly agent: Agent
  private readonly runOptions: AgentRunOptions

  public constructor(parent: AgentConfig, options: SubAgentOptions) {
    super()
    const tools = options.allowedTools
      ? buildRestrictedRegistry(parent.tools, options.allowedTools)
      : parent.tools

    this.agent = new Agent({
      ...parent,
      tools,
      model: options.model ?? parent.model,
      systemPrompt: options.systemPrompt ?? SUB_AGENT_SYSTEM_PROMPT(options.goal),
    })

    this.runOptions = {
      userMessage: options.goal,
      maxIterations: options.maxIterations ?? 10,
    }
  }

  public async run(): Promise<AgentRunResult> {
    // Agent.run throws on error — let it propagate (Rule 7).
    return this.agent.run(this.runOptions)
  }

  public async *stream(): AsyncGenerator<RunEvent> {
    yield* this.agent.streamRun(this.runOptions)
  }
}

/** Factory: create a sub-agent from a parent agent config + options. */
export const createSubAgent = (
  parent: AgentConfig,
  options: SubAgentOptions,
): BaseSubAgent => new SingleRunSubAgent(parent, options)

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