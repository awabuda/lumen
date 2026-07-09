/**
 * Agent team orchestration (P20.7.1).
 *
 * An *agent team* is a single declarative JSON file that bundles
 * several sub-agents and an orchestration mode. The P19.3 / P19.4
 * core already provides four primitive orchestrators
 * (sequential, parallel, handoff, supervisor); this module is
 * the CLI-side dispatcher that turns a `team.json` file into
 * one of those primitives.
 *
 * Design intent (see `docs/P20.7-agent-team.md`):
 *   - **No new core code.** The 4-mode orchestrators are
 *     already exported from `@lumen/core`; this module only
 *     bridges the JSON shape onto them. P19+ rule 11 (no
 *     middleware / boolean flags for "this is a team") and
 *     rule 15 (helper > abstract) both fall out naturally.
 *   - **Schema is the contract.** The Zod schema below is the
 *     single source of truth for `team.json`; tests pin every
 *     documented field. Operators get a precise error message
 *     when they get the shape wrong.
 *   - **Helpers, not classes.** Every public symbol here is a
 *     function; no abstract `BaseTeamRunner` (P19+ rule 14
 *     would reject it — the 4 modes already exist as separate
 *     factories in core).
 *
 * P20.7.x roadmap:
 *   - P20.7.2 — example team.json fixtures (code review team,
 *     research team, etc.) under `apps/cli/test/fixtures/`.
 *   - P20.7.3 — `lumen run --team <path>` flag wired into
 *     `apps/cli/src/commands/run.ts`.
 *   - P20.7.4 — shared `SqliteCheckpointStore` per team, so
 *     a sub-agent failure checkpoints the whole team.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type SubAgentSpec,
  SubAgentSpecSchema,
  createHandoffSubAgent,
  createParallelSubAgent,
  createSequentialSubAgent,
  createSupervisorSubAgent,
} from '@lumen/core'
import { z } from 'zod'

/** The four orchestration modes a team can pick. */
export const TeamModeSchema = z.enum(['sequential', 'parallel', 'handoff', 'supervisor'])
export type TeamMode = z.infer<typeof TeamModeSchema>

/**
 * A single prompt the orchestrator hands to one of the team's
 * sub-agents. `agentName` is resolved against
 * `team.agents[].name` at load time; the team is rejected at
 * validation if a task references an unknown agent.
 */
export const TeamTaskSchema = z
  .object({
    /** Name of the agent in `team.agents` that should run this task. */
    agentName: z.string().min(1),
    /** The prompt to send to that sub-agent. */
    prompt: z.string().min(1),
  })
  .strict()
export type TeamTask = z.infer<typeof TeamTaskSchema>

/**
 * Top-level shape of a `team.json` file.
 *
 * Why `agents` + `tasks` are separate (instead of tasks
 * embedding the agent spec directly): keeping a named pool of
 * agents makes `sequential` / `supervisor` mode compact
 * (one agent, many tasks) and lets a future `lumen team show`
 * command print the team's roster without re-parsing task
 * entries. It also mirrors the deepagents / Claude Code Task
 * pattern: agents are *named* and reusable, tasks are
 * per-orchestration invocations.
 */
export const TeamSchema = z
  .object({
    /** Human-facing team name. */
    name: z.string().min(1),
    /** One-sentence description of when to use this team. */
    description: z.string().optional(),
    /** Orchestration mode. Defaults to `sequential` for back-compat. */
    mode: TeamModeSchema.optional(),
    /**
     * Named sub-agents available to the team. Order matters for
     * `sequential` and `parallel` (tasks are run in declaration
     * order; if no `tasks` are listed, the orchestrator runs
     * each agent with its own `description` as the prompt).
     */
    agents: z.array(SubAgentSpecSchema).min(1),
    /**
     * Tasks to dispatch. If omitted, each agent runs once with
     * its description as the prompt. Validation rejects tasks
     * that reference an unknown agent name.
     */
    tasks: z.array(TeamTaskSchema).optional(),
  })
  .strict()
  .superRefine((team, ctx) => {
    // Cross-field check: every task must reference a known
    // agent. We do this in superRefine (not in TeamTaskSchema
    // itself) because the team-level agents list is what
    // determines which names are valid.
    const known = new Set(team.agents.map((a) => a.name))
    const declaredMode = team.mode ?? 'sequential'
    team.tasks?.forEach((task, i) => {
      if (!known.has(task.agentName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', i, 'agentName'],
          message: `unknown agent "${task.agentName}" (known: ${[...known].join(', ')})`,
        })
      }
    })
    // `supervisor` mode requires an explicit task list — the
    // supervisor decides `continue` / `redo` / `abort` per
    // task, and there is nothing to decide on an empty chain.
    if (declaredMode === 'supervisor' && (team.tasks?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tasks'],
        message: 'supervisor mode requires at least one task',
      })
    }
  })
export type Team = z.infer<typeof TeamSchema>

/** Errors thrown by the team module. */
export class TeamConfigError extends Error {
  public override readonly name = 'TeamConfigError'
  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    // Forward the cause to the public field so callers can
    // inspect it without digging into `error.cause` (which
    // is the spec-correct path but ergonomically awkward for
    // a CLI that prints a single line of error context).
    if (options?.cause !== undefined) this.cause = options.cause
  }
}

/** Read and parse a `team.json` file. */
export const loadTeam = async (path: string): Promise<Team> => {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    throw new TeamConfigError(
      `failed to read team file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new TeamConfigError(
      `team file at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  const result = TeamSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ')
    throw new TeamConfigError(`team file at ${path} failed validation: ${issues}`)
  }
  return result.data
}

/** Parent shape the 4 orchestrators accept. Mirrors core's contract. */
export interface TeamParent {
  readonly provider: import('@lumen/core').BaseProvider
  readonly tools: import('@lumen/core').ToolRegistry
  readonly model?: string
  readonly cwd?: string
}

/**
 * Dispatch a parsed team to one of the 4 P19.3 / P19.4
 * orchestrators. Returns a runner whose `run()` returns the
 * orchestrator's per-task results.
 *
 * Why return a runner instead of running eagerly: callers
 * (CLI commands, integration tests, future P20.7.3 wiring)
 * need to compose with streams, timeouts, and progress
 * reporting. The core orchestrators already have that
 * contract; we just dispatch.
 */
export interface TeamRunner {
  readonly id: string
  run(): Promise<ReadonlyArray<unknown>>
}

export const orchestrateTeam = (team: Team, parent: TeamParent): TeamRunner => {
  const mode: TeamMode = team.mode ?? 'sequential'
  // When `tasks` is missing, fall back to one task per agent
  // with the agent's description as the prompt. This keeps the
  // `agents: [...]` shorthand useful for tiny teams.
  const tasks = (
    team.tasks ?? team.agents.map((a) => ({ agentName: a.name, prompt: a.description }))
  ).map((t) => {
    const spec = team.agents.find((a) => a.name === t.agentName)
    // safeParse above guarantees this; the `!` is a type
    // assertion to satisfy TS without a non-null assertion
    // operator (P19+ style guide).
    if (!spec) {
      throw new TeamConfigError(`team references missing agent "${t.agentName}"`)
    }
    return { spec, prompt: t.prompt }
  })

  if (mode === 'sequential') {
    const orchestrator = createSequentialSubAgent({
      parent,
      tasks: tasks.map((t) => ({ spec: t.spec, prompt: t.prompt })),
    })
    return {
      id: `team:${team.name}:sequential`,
      run: async () => orchestrator.run(),
    }
  }
  if (mode === 'parallel') {
    const orchestrator = createParallelSubAgent({
      parent,
      tasks: tasks.map((t) => ({ spec: t.spec, prompt: t.prompt })),
    })
    return {
      id: `team:${team.name}:parallel`,
      run: async () => orchestrator.run(),
    }
  }
  if (mode === 'handoff') {
    // Handoff mode: each task runs as its own handoff sub-agent
    // that can voluntarily return control to the parent. We
    // run them sequentially for now (P20.7.1 scope). A future
    // P20.7.x ticket can introduce "parallel handoff" if a
    // use case shows up.
    return {
      id: `team:${team.name}:handoff`,
      run: async () => {
        const out: unknown[] = []
        for (const t of tasks) {
          const runner = createHandoffSubAgent({
            parent,
            spec: t.spec,
            prompt: t.prompt,
          })
          out.push(await runner.run())
        }
        return out
      },
    }
  }
  // mode === 'supervisor' (Zod enum guarantees this is exhaustive).
  const orchestrator = createSupervisorSubAgent({
    parent,
    tasks: tasks.map((t) => ({ spec: t.spec, prompt: t.prompt })),
  })
  return {
    id: `team:${team.name}:supervisor`,
    run: async () => {
      // Supervisor returns a single `AgentRunResult`, but the
      // `TeamRunner` contract returns an array. Wrap the
      // single result so callers get a uniform shape across
      // all 4 modes.
      const result = await orchestrator.run()
      return [result]
    },
  }
}

/** Resolve the effective mode of a parsed team (applies the default). */
export const resolveTeamMode = (team: Team): TeamMode => team.mode ?? 'sequential'

/**
 * Helper for `lumen team list` and similar read-only
 * inspection: returns the agent roster in declaration order.
 * Re-exported as a standalone function so tests can pin the
 * behaviour without going through `loadTeam`.
 */
export const listTeamAgents = (team: Team): ReadonlyArray<SubAgentSpec> => team.agents

// ---------------------------------------------------------------------------
// CLI command surface (P20.7.2)
// ---------------------------------------------------------------------------

/** Action the user asked `lumen team` to perform. */
export type TeamAction = 'list' | 'validate' | 'show' | 'run'

/** Options for {@link teamCommand}. */
export interface TeamCommandOptions {
  /** Which action to run. */
  readonly action: TeamAction
  /**
   * Path to a team.json file. Required for `validate`,
   * `show`, and `run`; ignored by `list` (which scans the
   * search dir instead).
   */
  readonly path?: string
  /**
   * Directory to scan for `lumen team list`. Defaults to
   * `./teams` (relative to cwd) and `./fixtures/teams` in
   * the working tree. The list action reports every
   * `team.json` it finds, plus a one-line summary.
   */
  readonly listDir?: string
  /**
   * `run` action only: the parent context the orchestrator
   * will dispatch sub-agents against. Callers in production
   * build this via `buildAgent({ ... })` from
   * `apps/cli/src/composition.ts`; tests inject a fake.
   * The teamCommand does not import `buildAgent` directly
   * (dependency-injection keeps the module testable without
   * hitting a real provider) — the caller is responsible
   * for the wire-up.
   */
  readonly runParent?: TeamParent
}

/**
 * Pretty-print a parsed team. Single source of truth for the
 * `lumen team show` and `lumen team list` output formats so
 * the two subcommands stay consistent.
 */
export const formatTeam = (team: Team, sourcePath?: string): string => {
  const lines: string[] = []
  const header = sourcePath ? `${team.name}  (${sourcePath})` : team.name
  lines.push(header)
  if (team.description) lines.push(`  ${team.description}`)
  lines.push(
    `  mode: ${resolveTeamMode(team)} · ${team.agents.length} agent${team.agents.length === 1 ? '' : 's'}${
      team.tasks ? ` · ${team.tasks.length} task${team.tasks.length === 1 ? '' : 's'}` : ''
    }`,
  )
  for (const a of team.agents) {
    lines.push(`  - ${a.name}: ${a.description}`)
  }
  return lines.join('\n')
}

/**
 * Pretty-print the per-task results of a team run. Each
 * orchestrator mode returns a slightly different shape
 * (sequential/parallel return per-task AgentRunResult;
 * handoff returns HandoffResult; supervisor returns a single
 * AgentRunResult wrapped in a 1-element array). We project
 * the most useful field — the final assistant message
 * content — out of whatever shape we got, falling back to a
 * JSON dump for shapes the teamCommand does not recognise.
 *
 * Pure function (no I/O) so the rendering can be unit-tested
 * by feeding hand-rolled result arrays.
 */
export const formatTeamResult = (result: unknown): string => {
  // The most common shape: AgentRunResult, with a `finalMessage`
  // carrying `content` (a string) and `toolCalls` (an array).
  if (
    typeof result === 'object' &&
    result !== null &&
    'finalMessage' in result &&
    typeof (result as { finalMessage: unknown }).finalMessage === 'object' &&
    (result as { finalMessage: { content?: unknown } }).finalMessage !== null
  ) {
    const fm = (result as { finalMessage: { content?: unknown; toolCalls?: unknown[] } })
      .finalMessage
    const content = typeof fm.content === 'string' ? fm.content : ''
    return content
  }
  // HandoffResult: { task, result, handoff? }
  if (typeof result === 'object' && result !== null && 'task' in result && 'result' in result) {
    const inner = (result as { result: unknown }).result
    const handoff = (result as { handoff?: { to: string; reason: string } }).handoff
    const base = formatTeamResult(inner)
    if (handoff) {
      return `${base}\n  [handoff → ${handoff.to}: ${handoff.reason}]`
    }
    return base
  }
  // Fallback: dump as JSON. Keeps the output useful for
  // shape mismatches (a future orchestrator mode we did not
  // anticipate) and for debugging.
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return '(unserializable result)'
  }
}

/**
 * Print every per-task result in declaration order, prefixed
 * by the task number + agent name + prompt. Used by the
 * `run` action so the operator sees one block per task.
 */
export const printTeamResults = (team: Team, results: ReadonlyArray<unknown>): void => {
  // Fall back to the implicit task list when the team did
  // not declare one — same shape as orchestrateTeam uses.
  const tasks = team.tasks ?? team.agents.map((a) => ({ agentName: a.name, prompt: a.description }))
  results.forEach((r, i) => {
    const task = tasks[i] ?? { agentName: '?', prompt: '?' }
    process.stdout.write(`[${i + 1}/${results.length}] ${task.agentName}  ${task.prompt}\n`)
    const body = formatTeamResult(r)
    // Indent every line of the body by two spaces so the
    // result visually nests under the task header.
    const indented = body
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')
    process.stdout.write(`${indented}\n\n`)
  })
}

/**
 * Read a directory and return every `team.json` it contains
 * (one level deep, non-recursive by design — operators with
 * deeply-nested team rosters can pass a more specific
 * `--list-dir`).
 */
const discoverTeamFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const { readdir, stat } = await import('node:fs/promises')
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (e.name !== 'team.json' && !e.name.endsWith('.team.json')) continue
    const full = join(dir, e.name)
    // stat to confirm it's a regular file (skip symlinks
    // pointing at directories etc.).
    try {
      const s = await stat(full)
      if (s.isFile()) out.push(full)
    } catch {
      // ignore — caller will surface the load error if they
      // try to read this file.
    }
  }
  return out.sort()
}

/**
 * CLI command for `lumen team list|validate|show`. Returns
 * an exit code; 0 on success, 1 on user error, 2 on
 * configuration error (consistent with the other CLI
 * commands — see `apps/cli/src/commands/chat.tsx`).
 */
export const teamCommand = async (options: TeamCommandOptions): Promise<number> => {
  const { action } = options

  if (action === 'list') {
    const dir = options.listDir ?? './teams'
    const files = await discoverTeamFiles(dir)
    if (files.length === 0) {
      process.stdout.write(`No team.json files found under ${dir}\n`)
      return 0
    }
    process.stdout.write(`Lumen teams under ${dir}\n\n`)
    for (const f of files) {
      try {
        const team = await loadTeam(f)
        process.stdout.write(`${formatTeam(team, f)}\n\n`)
      } catch (err) {
        // Surface the validation error inline so a single
        // broken team file does not mask the others. The
        // error is prefixed with the file path so the
        // operator can fix it without re-running with
        // verbose mode.
        const msg = err instanceof Error ? err.message : String(err)
        process.stdout.write(`! ${f}\n  ${msg}\n\n`)
      }
    }
    return 0
  }

  // validate + show both need a path
  if (!options.path) {
    process.stderr.write(`lumen team ${action}: missing <path> to a team.json file\n`)
    return 2
  }

  let team: Team
  try {
    team = await loadTeam(options.path)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`lumen team ${action}: ${msg}\n`)
    return 1
  }

  if (action === 'validate') {
    // loadTeam already ran the full Zod parse + superRefine,
    // so reaching here means the file is valid. We still
    // print a confirmation line so the operator can see
    // what was checked.
    process.stdout.write(
      `ok: ${options.path}  (name=${team.name}, mode=${resolveTeamMode(team)}, agents=${team.agents.length}${
        team.tasks ? `, tasks=${team.tasks.length}` : ''
      })\n`,
    )
    return 0
  }

  if (action === 'run') {
    if (!options.runParent) {
      process.stderr.write(
        'lumen team run: internal error — no runParent provided. The CLI dispatcher is responsible for building it via buildAgent().\n',
      )
      return 2
    }
    const runner = orchestrateTeam(team, options.runParent)
    process.stdout.write(`Running team "${team.name}" (mode=${resolveTeamMode(team)})\n\n`)
    let results: ReadonlyArray<unknown>
    try {
      results = await runner.run()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`lumen team run: ${team.name} failed: ${msg}\n`)
      return 1
    }
    printTeamResults(team, results)
    return 0
  }

  // action === 'show'
  process.stdout.write(`${formatTeam(team, options.path)}\n`)
  if (team.tasks && team.tasks.length > 0) {
    process.stdout.write('\n  tasks:\n')
    for (const t of team.tasks) {
      process.stdout.write(`  - ${t.agentName}: ${t.prompt}\n`)
    }
  }
  return 0
}
