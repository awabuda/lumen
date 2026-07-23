/**
 * P27.1 (bug.md #10) \u2014 `lumen computer` subcommand.
 *
 * P24.5 \u00a72 documents the operator workaround for bug.md
 * #10 Computer Use: drive a headless Chromium via the
 * existing `web_browser` tool. The workaround is a
 * one-liner:
 *
 *     lumen run --web-browser --approve-on web_browser \
 *         "navigate to example.com, log in, screenshot"
 *
 * P27.1 ships a first-class `lumen computer` subcommand
 * that pre-applies the flag set and prepends a one-line
 * hint to the operator's prompt. NO native-dep change;
 * P22.7 \u00a73 guardrail stays intact.
 *
 * Why a subcommand (P19+ rule 15) and not a new
 * `BaseSubCommand` class: the body is a thin
 * composition over the existing `runCommand` (P22.2).
 * A class adds zero behavioural gain.
 */

import { runCommand, type RunCommandOptions } from './run.js'

export interface ComputerCommandOptions {
  prompt: string
  model?: string
  configPath?: string
  cwd?: string
  apiKey?: string
  baseUrl?: string
  /** Optional pre-set allow-list (default: ['web_browser']). */
  approveOn?: ReadonlyArray<string>
  /** Optional pre-set interrupt list (default: []). */
  interruptOn?: ReadonlyArray<string>
  /** Permissions file (forwarded to `runCommand`). */
  permissionsPath?: string
  /**
   * Disable the prompt-prefix hint that explains the
   * web_browser availability. Default: false (the hint
   * IS prepended).
   */
  noPrefix?: boolean
  /** Path to the Chromium executable (forwarded to
   *  `runCommand` as `--web-browser-exe`). */
  webBrowserExe?: string
  /** Domain allow-list (forwarded to
   *  `runCommand` as `--web-browser-allowed-domains`). */
  webBrowserAllowedDomains?: ReadonlyArray<string>
  /** Persistent memory path. */
  memoryPath?: string
  /** Disable the persistent memory store. */
  noMemory?: boolean
  /** Disable MCP server discovery. */
  noMcp?: boolean
  /** Mute stderr (used by the unit test). */
  quiet?: boolean
  /**
   * Resolve the options and print a one-line summary
   * without invoking the agent loop. The pre-flight
   * check is useful when the operator wants to confirm
   * the resolved flag set before committing to a
   * (potentially expensive) agent run.
   */
  dryRun?: boolean
  /**
   * Pair with `--dry-run`: emit the resolved options as
   * JSON instead of the human-readable multi-line text.
   * Useful for scripts and CI pipelines.
   */
  dryRunJson?: boolean
}

const PROMPT_PREFIX = [
  '[lumen computer] You have a headless Chromium browser',
  'available via the `web_browser` tool. Use goto / act /',
  'extract / screenshot. The operator has pre-approved',
  'every `web_browser` call. When you finish, summarise the',
  'actions you took in plain text.',
].join(' ')

/** Build the prefixed prompt the agent will see. Pure
 *  helper so the unit test can pin the exact string. */
export const buildComputerPrompt = (userPrompt: string): string =>
  `${PROMPT_PREFIX}\n\n${userPrompt}`

/**
 * Resolve the RunCommandOptions the subcommand WOULD
 * pass, without invoking the agent loop. Pure helper so
 * the unit test can pin the exact shape and so
 * `lumen computer --dry-run` can print a one-line
 * summary.
 */
export const resolveComputerRunOptions = (
  options: ComputerCommandOptions,
): RunCommandOptions => {
  const approveOn = options.approveOn ?? (['web_browser'] as const)
  const interruptOn = options.interruptOn ?? []
  const prompt = options.noPrefix === true
    ? options.prompt
    : buildComputerPrompt(options.prompt)
  return {
    prompt,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.permissionsPath !== undefined
      ? { permissionsPath: options.permissionsPath }
      : {}),
    ...(options.memoryPath !== undefined ? { memoryPath: options.memoryPath } : {}),
    ...(options.noMemory === true ? { noMemory: true } : {}),
    ...(options.noMcp === true ? { noMcp: true } : {}),
    approveOn,
    interruptOn,
    webBrowser: true,
    ...(options.webBrowserExe !== undefined
      ? { webBrowserExe: options.webBrowserExe }
      : {}),
    ...(options.webBrowserAllowedDomains !== undefined
      ? { webBrowserAllowedDomains: options.webBrowserAllowedDomains }
      : {}),
  }
}

/** Render a resolved-options summary. Used by
 *  `--dry-run`; pure helper. */
export const formatDryRun = (options: RunCommandOptions): string => {
  const lines = [
    'lumen computer (dry run)',
    `  prompt:        ${JSON.stringify(options.prompt).slice(0, 80)}${options.prompt.length > 80 ? '…' : ''}`,
    `  webBrowser:    ${options.webBrowser === true ? 'true' : 'false'}`,
    `  approveOn:     ${options.approveOn?.join(', ') ?? '(default)'}`,
    `  interruptOn:   ${options.interruptOn?.join(', ') ?? '(none)'}`,
    ...(options.webBrowserExe !== undefined
      ? [`  webBrowserExe: ${options.webBrowserExe}`]
      : []),
    ...(options.webBrowserAllowedDomains !== undefined
      ? [`  allowed:       ${options.webBrowserAllowedDomains.join(', ')}`]
      : []),
    ...(options.model !== undefined ? [`  model:         ${options.model}`] : []),
  ]
  return lines.join('\n')
}

/**
 * JSON variant of the dry-run summary. Used by
 * `--dry-run --json`; pure helper. Operators running
 * the subcommand from a script can pipe the JSON
 * output into `jq` for further processing.
 */
export const formatDryRunJson = (options: RunCommandOptions): string => {
  // Stable key order so the JSON output is deterministic
  // for diff-friendly scripts.
  const obj = {
    prompt: options.prompt,
    webBrowser: options.webBrowser === true,
    approveOn: options.approveOn ?? null,
    interruptOn: options.interruptOn ?? null,
    webBrowserExe: options.webBrowserExe ?? null,
    webBrowserAllowedDomains: options.webBrowserAllowedDomains ?? null,
    model: options.model ?? null,
  }
  return JSON.stringify(obj, null, 2)
}

/**
 * The `lumen computer` subcommand body. Thin composition
 * over `runCommand`; the only "new" surface is the
 * prefixed prompt + the default `--web-browser` /
 * `--approve-on web_browser` flag set.
 *
 * `dryRun: true` resolves the same options and prints a
 * one-line summary without invoking the agent loop.
 */
export const computerCommand = async (
  options: ComputerCommandOptions & { readonly dryRun?: boolean },
): Promise<number> => {
  const runOptions = resolveComputerRunOptions(options)
  if (options.dryRun === true) {
    if (options.dryRunJson === true) {
      process.stdout.write(`${formatDryRunJson(runOptions)}\n`)
    } else {
      process.stdout.write(`${formatDryRun(runOptions)}\n`)
    }
    return 0
  }
  return runCommand(runOptions)
}