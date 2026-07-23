/**
 * `lumen run "<prompt>"` — single-shot CLI: run one prompt, print the
 * answer, exit. No TUI, no streaming, no interactivity. Designed for
 * scripts and one-off questions.
 *
 * Exit codes:
 *   0 — success
 *   1 — agent error (network, provider, validation)
 *   2 — configuration error (missing API key, etc.)
 *   130 — interrupted (SIGINT)
 */

import { findResumeCheckpoint } from '../checkpoint-resume.js'
import { loadCliConfig } from '../composition.js'

export interface RunCommandOptions {
  prompt: string
  model?: string
  configPath?: string
  cwd?: string
  apiKey?: string
  baseUrl?: string
  noTools?: boolean
  /** Skip wiring a memory store (defaults to in-memory SQLite at
   *  `~/.lumen/memory.db`). Tests pass `:memory:` for hermetic
   *  runs. */
  memoryPath?: string
  noMemory?: boolean
  /** Skip MCP server discovery + connection. */
  noMcp?: boolean
  /** P24.4 (bug.md #9) — opt-in browser automation.
   *  Maps to `BuildOptions.webBrowser`; consumed by
   *  `buildAgent` to register `web_browser` on the
   *  registry when true. Off by default because the tool
   *  is `approval-required`. */
  webBrowser?: boolean
  /** Override the Chromium executable path. */
  webBrowserExe?: string
  /** Optional domain allow-list. */
  webBrowserAllowedDomains?: ReadonlyArray<string>
  /**
   * P20.1.3: tool names whose dispatch throws AbortError.
   * Forwarded to `buildAgent({ interruptOn })`; empty array is
   * a no-op. Multiple names allowed.
   */
  interruptOn?: ReadonlyArray<string>
  /** Pre-approve tool names listed in interruptOn. */
  approveOn?: ReadonlyArray<string>
  /** P22.2: path to a YAML permission policy file. */
  permissionsPath?: string
  /**
   * P22.5.3: when true, print a one-line confirmation that
   * auto-mode is enabled (based on the policy file's
   * `autoMode.enabled` flag). The flag itself does NOT
   * override the policy file; the file is the source of
   * truth. A missing `autoMode:` block or `enabled: false`
   * triggers a hint to edit the file. A `--permissions`
   * flag is also required.
   */
  autoMode?: boolean
  /**
   * P19.0.3 follow-up: when true, buildAgent wires the
   * PlanMiddleware with `planMode ?? 'auto'`.
   */
  enablePlanMiddleware?: boolean
  /** Plan mode. Only meaningful when `enablePlanMiddleware` is true. */
  planMode?: 'plan' | 'act' | 'auto'
  /**
   * P20.4 follow-up: SQLite path for the checkpoint store.
   * Forwarded to `buildAgent`. Omit to skip checkpoint wiring.
   */
  checkpointPath?: string
  /**
   * P20.6.2: wire `createSkillTriggerMiddleware` into the
   * agent loop. Forwarded to `buildAgent({ enableSkillTrigger })`.
   * Off by default.
   */
  enableSkillTrigger?: boolean
  /**
   * P20.6.2: override the skill root directory. Forwarded to
   * `buildAgent({ skillsPath })`. Has no effect when
   * `enableSkillTrigger` is false.
   */
  skillsPath?: string
  /** Disable automatic resume from a fresh in-progress checkpoint. */
  noResume?: boolean
  /** Maximum age in milliseconds for automatic resume. Defaults to 10 minutes. */
  resumeTtlMs?: number
  /** Optional session scope for automatic resume discovery. */
  sessionId?: string
  /** Checkpoint cadence forwarded to Agent.run. */
  checkpointInterval?: number
}

export const runCommand = async (options: RunCommandOptions): Promise<number> => {
  // Defer the heavy import so the command surface stays light.
  const { buildAgent } = await import('../composition.js')

  // P22.5.3: when --auto-mode is set, surface a one-line
  // status that the operator can see before the run
  // starts. The flag itself does not override the policy
  // file; the file is the source of truth.
  if (options.autoMode === true) {
    if (options.permissionsPath === undefined) {
      process.stderr.write(
        'lumen: --auto-mode requires --permissions <path>; the policy file declares the autoMode block.\n',
      )
      return 2
    }
    const { loadPermissionPolicyFromFile } = await import('../permissions-loader.js')
    try {
      const parsed = await loadPermissionPolicyFromFile(options.permissionsPath)
      if (parsed.autoMode?.enabled === true) {
        process.stdout.write(
          `auto-mode: enabled (heuristic classifier + ${parsed.autoMode.neverAllowTools.length} never-allow tool(s))\n`,
        )
      } else {
        process.stdout.write(
          `auto-mode: not enabled in ${options.permissionsPath}; edit the file's autoMode block to set enabled: true\n`,
        )
      }
    } catch (err) {
      process.stderr.write(
        `lumen: --auto-mode could not read policy: ${(err as Error).message ?? String(err)}\n`,
      )
      return 2
    }
  }

  // Pre-flight: surface the missing-key error **before** we
  // touch the filesystem (buildAgent opens the SQLite
  // memory file). This keeps the failure cheap and the
  // error message specific — the user is told they need
  // a key, not that we couldn't open a database.
  if (!process.env.OPENAI_API_KEY && !process.env.LUMEN_API_KEY && !options.apiKey) {
    process.stderr.write(
      'lumen: missing API key. Set OPENAI_API_KEY or LUMEN_API_KEY, or pass --api-key.\n',
    )
    return 2
  }

  let built: Awaited<ReturnType<typeof buildAgent>> | undefined
  try {
    built = await buildAgent(options)
    // P20.4: when --checkpoint is given, wire a persistent
    // checkpoint store so the run auto-saves on throw and
    // becomes resumable via `lumen checkpoint show` / a
    // follow-up `lumen run --resume-from` call.
    const { SqliteCheckpointStore } = await import('@lumen/memory')
    const checkpointStore = options.checkpointPath
      ? new SqliteCheckpointStore({ path: options.checkpointPath })
      : undefined
    try {
      const resumeFrom = checkpointStore
        ? await findResumeCheckpoint({
            store: checkpointStore,
            enabled: options.noResume !== true,
            ...(options.resumeTtlMs !== undefined ? { ttlMs: options.resumeTtlMs } : {}),
            ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          })
        : undefined
      const result = await built.agent.run({
        userMessage: options.prompt,
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(checkpointStore ? { checkpointStore } : {}),
        ...(resumeFrom ? { resumeFrom } : {}),
        ...(options.checkpointInterval !== undefined
          ? { checkpointInterval: options.checkpointInterval }
          : {}),
      })
      if (result.finalMessage.content) {
        process.stdout.write(result.finalMessage.content)
        if (!result.finalMessage.content.endsWith('\n')) {
          process.stdout.write('\n')
        }
      } else if (result.finalMessage.toolCalls.length > 0) {
        // The model called tools but never produced text. Surface what it did.
        process.stdout.write(
          `[lumen] agent stopped after ${result.iterations} iteration(s) with ${result.finalMessage.toolCalls.length} tool call(s) and no final text.\n`,
        )
      }
      return 0
    } finally {
      // P20.4: tear down the SQLite checkpoint store so the
      // WAL gets checkpointed and the file handle is closed.
      // No-op when the caller did not pass --checkpoint.
      await checkpointStore?.dispose()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`lumen: ${message}\n`)
    return 1
  } finally {
    // Always dispose the memory store. We do this even on
    // error because a half-finished run may have already
    // appended the user message; we want the connection
    // closed cleanly so WAL gets checkpointed.
    await built?.memory?.dispose()
    // Close any MCP server connections. `closeAllMcpServers`
    // already uses Promise.allSettled, so a single stuck
    // server can't keep the CLI alive.
    if (built?.mcpServers.length) {
      const { closeAllMcpServers } = await import('@lumen/mcp')
      await closeAllMcpServers(built.mcpServers)
    }
  }
}

// Mark the side-effect import as used; the command delegates to buildAgent.
void loadCliConfig
