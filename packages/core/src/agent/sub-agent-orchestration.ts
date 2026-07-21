/**
 * Sub-agent orchestration (P19.3.4 / P19.3.5).
 *
 * Sequential and parallel sub-agent runners. Both are plain factory
 * helpers that return objects with `run()` and `stream()`; there is
 * no abstract class involved (P19+ rule 14).
 *
 * Sequential: tasks run one at a time, in order. Each task's
 * AgentRunResult is collected into a list. If any task throws,
 * sequential aborts and re-throws.
 *
 * Parallel: tasks run via `Promise.all` with a per-task max-iterations
 * and a hard wall-clock timeout (default 60s, matching the P18.3
 * concurrency budget). Results are returned in the same order as
 * the input tasks.
 */

import { z } from 'zod'

import type { AgentRunResult } from './index.js'
import {
  type SubAgentRunner,
  type SubAgentSpec,
  SubAgentSpecSchema,
  createSubAgentFromSpec,
} from './sub-agent.js'

/** A single unit of work for the orchestrator. */
export interface SubAgentTask {
  readonly spec: SubAgentSpec
  readonly prompt: string
  readonly maxIterations?: number
}

export const SubAgentTaskSchema = z
  .object({
    spec: SubAgentSpecSchema,
    prompt: z.string().min(1),
    maxIterations: z.number().int().positive().optional(),
  })
  .strict()

/** Per-task output preserved on the orchestrated result. */
export interface SubAgentTaskResult {
  readonly task: SubAgentTask
  readonly result: AgentRunResult
}

const TaskResultSchema = z.object({
  task: SubAgentTaskSchema,
  result: z.custom<AgentRunResult>(),
})

/** Common runner contract for sequential and parallel sub-agent orchestration. */
export interface SubAgentOrchestrator {
  readonly id: string
  run(): Promise<ReadonlyArray<SubAgentTaskResult>>
  stream(): AsyncGenerator<SubAgentTaskResult>
}

/** Per-call default for parallel wall-clock budget. Matches P18.3. */
export const PARALLEL_DEFAULT_TIMEOUT_MS = 60_000

/** Options shared by sequential and parallel sub-agent runners. */
export interface SubAgentOrchestratorOptions {
  /** Parent agent config used to spawn sub-agents. */
  readonly parent: {
    readonly provider: import('../message/provider.js').BaseProvider
    readonly tools: import('../tools/index.js').ToolRegistry
    readonly model?: string
    readonly cwd?: string
  }
  /** Ordered list of tasks. */
  readonly tasks: ReadonlyArray<SubAgentTask>
  /** Per-task max-iterations fallback. */
  readonly maxIterations?: number
}

const parseOptions = (
  options: SubAgentOrchestratorOptions,
): {
  parent: SubAgentOrchestratorOptions['parent']
  tasks: ReadonlyArray<SubAgentTask>
  maxIterations: number
} => {
  const tasks = options.tasks.map((t) => SubAgentTaskSchema.parse(t))
  return {
    parent: options.parent,
    tasks,
    maxIterations: options.maxIterations ?? 10,
  }
}

const buildRunner = (
  parent: SubAgentOrchestratorOptions['parent'],
  task: SubAgentTask,
  maxIterations: number,
): SubAgentRunner => {
  const parentConfig: {
    provider: SubAgentOrchestratorOptions['parent']['provider']
    tools: SubAgentOrchestratorOptions['parent']['tools']
    model?: string
    cwd?: string
  } = {
    provider: parent.provider,
    tools: parent.tools,
  }
  if (parent.model !== undefined) parentConfig.model = parent.model
  if (parent.cwd !== undefined) parentConfig.cwd = parent.cwd
  return createSubAgentFromSpec(
    parentConfig,
    task.spec,
    task.prompt,
    task.maxIterations ?? maxIterations,
  )
}

/** Create a sequential sub-agent orchestrator. */
export const createSequentialSubAgent = (
  options: SubAgentOrchestratorOptions,
): SubAgentOrchestrator => {
  const parsed = parseOptions(options)

  return {
    id: 'sequential',
    async run(): Promise<ReadonlyArray<SubAgentTaskResult>> {
      const out: SubAgentTaskResult[] = []
      for (const task of parsed.tasks) {
        const runner = buildRunner(parsed.parent, task, parsed.maxIterations)
        const result = await runner.run()
        out.push({ task, result })
      }
      return out
    },
    async *stream(): AsyncGenerator<SubAgentTaskResult> {
      for (const task of parsed.tasks) {
        const runner = buildRunner(parsed.parent, task, parsed.maxIterations)
        const result = await runner.run()
        const entry: SubAgentTaskResult = { task, result }
        yield entry
      }
    },
  }
}

/** Create a parallel sub-agent orchestrator with a wall-clock timeout. */
export const createParallelSubAgent = (
  options: SubAgentOrchestratorOptions,
  timeoutMs = PARALLEL_DEFAULT_TIMEOUT_MS,
): SubAgentOrchestrator => {
  const parsed = parseOptions(options)

  return {
    id: 'parallel',
    async run(): Promise<ReadonlyArray<SubAgentTaskResult>> {
      const runners = parsed.tasks.map((task) =>
        buildRunner(parsed.parent, task, parsed.maxIterations).run(),
      )
      const settled = await withTimeout(Promise.allSettled(runners), timeoutMs)
      const results: SubAgentTaskResult[] = []
      for (let i = 0; i < parsed.tasks.length; i += 1) {
        const task = parsed.tasks[i]
        const r = settled[i]
        if (!task || !r) continue
        if (r.status === 'rejected') {
          throw r.reason instanceof Error
            ? r.reason
            : new Error(String(r.reason ?? 'sub-agent failed'))
        }
        results.push({ task, result: r.value })
      }
      return results
    },
    async *stream(): AsyncGenerator<SubAgentTaskResult> {
      // P23.7 (fix #23) — yield each task as it completes, not
      // after all of them settle. Pre-P23.7 the stream() method
      // ran every task via Promise.allSettled first, then
      // iterated the results in order — making the stream
      // functionally identical to `run()` for any caller that
      // awaited the generator one entry at a time (which is
      // every caller).
      //
      // The new implementation kicks off every task with a
      // tagged promise, then races the live set: at each step
      // we wait for the FIRST of the remaining promises to
      // settle (Promise.race) and yield its result. The tag is
      // a per-task unique object so we can identify and remove
      // the settled promise from the map by reference. The
      // timeout bounds the whole batch.
      const tasks = parsed.tasks
      const pending = new Map<object, Promise<{ tag: object; entry: SubAgentTaskResult | Error }>>()
      for (const task of tasks) {
        const tag = {}
        const promise = buildRunner(parsed.parent, task, parsed.maxIterations)
          .run()
          .then(
            (result) => ({ tag, entry: { task, result } as SubAgentTaskResult | Error }),
            (err) => ({
              tag,
              entry: (err instanceof Error ? err : new Error(String(err))) as
                | SubAgentTaskResult
                | Error,
            }),
          )
        pending.set(tag, promise)
      }

      while (pending.size > 0) {
        const raced = await withTimeout(Promise.race(Array.from(pending.values())), timeoutMs)
        pending.delete(raced.tag)
        if (raced.entry instanceof Error) throw raced.entry
        yield raced.entry
      }
    },
  }
}

/** Race a promise against a wall-clock timeout. */
const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`parallel sub-agent timeout after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Backwards-friendly aliases. */
export const SequentialSubAgent = createSequentialSubAgent
export const ParallelSubAgent = createParallelSubAgent

// Re-export the helper to keep the public surface discoverable.
export { TaskResultSchema }
