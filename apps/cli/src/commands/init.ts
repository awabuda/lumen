/** P22.3 — `lumen init` writes a starter `~/.lumen/permissions.yaml`.
 *  2026-07-29 audit GAP-3 follow-up: `--with-config` also writes a
 *  starter `~/.lumen/config.yaml` so `lumen model list` and
 *  `composition.ts`'s `defaultModel` resolution have a working
 *  baseline. Without it, the operator hits the new
 *  "No LLM model configured" ConfigError (commit 677233e) on
 *  first install with no actionable hint about where to put
 *  their config.
 *
 *  P31.7 — `--with-context` also writes a starter `<cwd>/.lumen/`
 *  directory containing `AGENTS.md` (P31 §1.2 P1) and
 *  `TOOLS.md` (P31 §1.2 G1) so the cwd walk-up in the next
 *  session picks up the project notes. The TOOLS template
 *  carries the §1.10 disclaimer verbatim (prompt describes
 *  tools; runtime registry is authoritative).
 */

import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  contextInitFilesFor,
  starterAgentsMdPath,
  starterToolsTemplatePath,
} from './init-templates.js'

/** Default path of the permissions file. */
export const defaultPermissionsPath = (): string =>
  process.env.LUMEN_PERMISSIONS_PATH ?? join(homedir(), '.lumen', 'permissions.yaml')

/** Default path of the main config file (P-2026-07-29 audit GAP-3). */
export const defaultConfigPath = (): string =>
  process.env.LUMEN_CONFIG_PATH ?? join(homedir(), '.lumen', 'config.yaml')

/** Starter policy text. The starter keeps `default: ask` so the
 *  operator must explicitly opt into `allow` for a tool to be
 *  freely dispatched; this matches the P22 design doc §4.4. */
export const starterPermissionPolicy = (): string => `# Lumen tool permission policy (P22).
#
# This file is the static, deterministic rule list for the
# tool-permission middleware. It is the outermost gate in the
# composition chain; the interrupt middleware (P20.1) sits behind
# it for the \`ask\` decisions.
#
# Three decisions per rule:
#   allow — short-circuits; the call dispatches
#   deny  — throws a typed AbortError; the P20.4.2 catch path
#           auto-saves a checkpoint
#   ask   — falls through to the interrupt middleware
#
# Edit the rules below to fit your workflow. The starter ships
# with read-only tools allowed by default and write/exec tools
# explicitly denied — a "least privilege" baseline you can relax
# after reading docs/PERMISSIONS.md.

version: 1
default: ask

rules:
  - name: allow-read-file
    tools: [read_file]
    decision: allow

  - name: allow-list-dir
    tools: [list_dir]
    decision: allow

  - name: allow-search
    tools: [search_files]
    decision: allow

  - name: deny-terminal
    tools: [terminal]
    decision: deny
    # P22 follow-up: ask the host when the operator uncomments the
    # 'ask-on-miss' rule below and removes the deny rule.
`

/** Starter main config (P-2026-07-29 audit GAP-3).
 *
 *  The starter is intentionally MINIMAL — it does NOT pre-fill
 *  `defaultModel` or `providers[0].apiKey` because those values
 *  are endpoint- and key-specific. The comments below show the
 *  exact schema; the operator copies the example, swaps in their
 *  own values, and re-runs `lumen doctor` to confirm.
 *
 *  Resolution order (composition.ts, post-677233e):
 *    1. CLI --model flag (highest priority)
 *    2. config.defaultModel  ← THIS FILE
 *    3. LUMEN_MODEL env
 *    4. LUMEN_DEFAULT_MODEL env
 *    All four undefined → typed ConfigError
 */
export const starterConfigTemplate = (): string => {
  const date = new Date().toISOString().slice(0, 10)
  return `# Lumen main config — ${date}
#
# Written by \`lumen init --with-config\` (P-2026-07-29 audit
# GAP-3 follow-up). This file is read by every CLI subcommand;
# leaving it empty means composition.ts relies on env vars or
# CLI flags for the LLM model.
#
# Pick ONE of the three configuration paths below and uncomment
# the matching block. Pick (A) for OpenAI; (B) for any
# OpenAI-compatible endpoint (MiniMax, llama.cpp, Mistral,
# Anthropic-via-gateway, etc.); (C) for Anthropic first-party.

# ──────────────────────────────────────────────────────────────
# (A) OpenAI (first-party)
# ──────────────────────────────────────────────────────────────
# providers:
#   - id: openai
#     apiKey: sk-...                       # or set OPENAI_API_KEY env
#     baseUrl: https://api.openai.com/v1
# defaultModel: gpt-4o-mini
# models:
#   - provider: openai
#     name: gpt-4o-mini
#     temperature: 0.2

# ──────────────────────────────────────────────────────────────
# (B) OpenAI-compatible endpoint (MiniMax, llama.cpp, etc.)
# ──────────────────────────────────────────────────────────────
# Set LUMEN_API_KEY (or OPENAI_API_KEY) in your shell so the
# key never lands in this file. baseUrl points at the
# provider's /v1 endpoint; \`name\` is whatever the provider
# calls its model (run \`curl \$baseUrl/models\` to discover).
#
# providers:
#   - id: openai
#     apiKey: sk-...                       # or env
#     baseUrl: https://api.minimax.chat/v1
# defaultModel: MiniMax-Text-01
# models:
#   - provider: openai
#     name: MiniMax-Text-01
#     temperature: 0.2

# ──────────────────────────────────────────────────────────────
# (C) Anthropic first-party
# ──────────────────────────────────────────────────────────────
# provider wiring lives in apps/cli/src/composition.ts — the
# CLI composition root currently uses OpenAICompatibleProvider
# exclusively, so to actually route to Anthropic you need to
# swap the provider construction in composition.ts (out of
# scope for \`lumen init\`. For now, route Anthropic via an
# OpenAI-compatible gateway and use block (B).

# ──────────────────────────────────────────────────────────────
# Everything below this line is OPTIONAL. Defaults shown.
# ──────────────────────────────────────────────────────────────
agent:
  maxIterations: 50       # upper bound on tool-call loop iterations
  # budgetTokens: 200000  # hard cap; agent aborts when exceeded
  # budgetCostUsd: 1.00   # hard cap; uses provider-reported cost
  oneTurnGraceCall: true  # let a tool-call response finish even after the budget exits
  stream: true            # stream model output to stdout / TUI

memory:
  backend: sqlite         # sqlite (default) or none
  vectorDimensions: 1536  # must match your embedder; 1536 for OpenAI text-embedding-3-small
  ftsEnabled: true        # FTS5 keyword search; off if you only use vector recall

tools:
  enabled: []             # explicit allow-list (empty = use framework default)
  disabled: []            # deny-list
  defaultTimeoutMs: 30000
  dangerousRequireApproval: true

skills:
  directories: []         # extra skill roots; default ~/.lumen/skills is always scanned
  autoEvolve: true        # reflect every N invocations and rewrite stale skills
  reflectEveryNInvocations: 5

mcp:
  servers: []             # see docs/P24.3-fail-closed.md for the security policy
  # security:
  #   failClosed: true               # default
  #   allowServerIds: [github, ...]  # explicit allow-list

logging:
  level: info             # trace | debug | info | warn | error
  redactSecrets: true     # scrub apiKey / Authorization headers from logs

# ──────────────────────────────────────────────────────────────
# P38.a — Product assembly (OPT-IN: P33.B Day4). Uncomment
# the next line to make every run / chat mount the
# assistant assembly (plan / permission / skill / reflection
# middleware). The default is bare; see BUILTIN_ASSEMBLIES.
# ──────────────────────────────────────────────────────────────
# defaultProfile: assistant
`
}

/** Options for {@link initCommand}. */
export interface InitCommandOptions {
  /** Override the destination path (default: ~/.lumen/permissions.yaml). */
  path?: string
  /** Overwrite an existing file. */
  force?: boolean
  /** P-2026-07-29 audit GAP-3: also write the starter main config
   *  (`~/.lumen/config.yaml`) alongside the permissions policy.
   *  Without this flag, `lumen init` only writes the permissions
   *  file (the original P22.3 surface). */
  withConfig?: boolean
  /** Override the main config destination (requires --with-config). */
  configPath?: string
  /** P31.7: also write a starter `<cwd>/.lumen/` directory with
   *  `AGENTS.md` (P1 walk-up target) and `TOOLS.md` (G1 with
   *  the §1.10 disclaimer). The cwd defaults to `process.cwd()`
   *  at the time the command runs; pass `--cwd <path>` to
   *  target a different project root. The `cwd` option is the
   *  same shape as AgentConfig.cwd and any future composition
   *  cwd resolver. */
  withContext?: boolean
  /** Override the cwd for `--with-context` (default: current cwd). */
  cwd?: string
  /**
   * P38.a — when set alongside `--with-config`, append
   * `defaultProfile: assistant` to the starter main
   * config so the operator's first `lumen run` lands in
   * the assistant assembly (plan / permission / skill /
   * reflection middleware all mounted). The default
   * profile name is `'assistant'` (P33.B Day4); the
   * `--with-default-profile` flag without a value is
   * intentional — a profile name parameter is out of
   * scope for P38.a (operators who want `bare` etc.
   * edit the config directly).
   */
  withDefaultProfile?: boolean
}

/** Run the `lumen init` command. Returns 0 on success, 2 on conflict. */
export const initCommand = async (options: InitCommandOptions = {}): Promise<number> => {
  const dest = resolve(options.path ?? defaultPermissionsPath())
  let exists = false
  try {
    await fs.access(dest)
    exists = true
  } catch {
    exists = false
  }
  if (exists && options.force !== true) {
    process.stderr.write(
      `lumen init: file already exists at ${dest}\nre-run with --force to overwrite.\n`,
    )
    return 2
  }
  await fs.mkdir(resolve(dest, '..'), { recursive: true })
  await fs.writeFile(dest, starterPermissionPolicy(), 'utf8')
  process.stdout.write(`wrote ${dest}\n`)

  // P-2026-07-29 audit GAP-3: optional starter main config.
  // When --with-config is set, write the commented-out template
  // next to the permissions file so the operator has a starting
  // point for `defaultModel` / `providers` / `models`.
  if (options.withConfig === true) {
    const cfgDest = resolve(options.configPath ?? defaultConfigPath())
    let cfgExists = false
    try {
      await fs.access(cfgDest)
      cfgExists = true
    } catch {
      cfgExists = false
    }
    if (cfgExists && options.force !== true) {
      process.stderr.write(
        `lumen init: file already exists at ${cfgDest}\nre-run with --force to overwrite.\n`,
      )
      return 2
    }
    await fs.mkdir(resolve(cfgDest, '..'), { recursive: true })
    // P38.a — when --with-default-profile is set, the
    // starter template's commented `defaultProfile: ...`
    // line is uncommented so the assistant assembly
    // mounts out of the box. We splice on the literal
    // uncommented line at a stable marker so the
    // pre-existing template body is unchanged.
    const baseConfig = starterConfigTemplate()
    const finalConfig =
      options.withDefaultProfile === true
        ? baseConfig.replace('# defaultProfile: assistant', 'defaultProfile: assistant')
        : baseConfig
    await fs.writeFile(cfgDest, finalConfig, 'utf8')
    process.stdout.write(`wrote ${cfgDest}\n`)
  }

  // P31.7 — emit the layered system-prompt walk-up surface
  // (AGENTS.md for P1 + TOOLS.md for G1 with the §1.10
  // disclaimer) under `<cwd>/.lumen/`. Idempotent on the
  // existing files: existing files are reported but not
  // overwritten unless --force is set, matching the
  // permissions / config semantics.
  if (options.withContext === true) {
    const cwdRoot = options.cwd ?? process.cwd()
    const written = []
    const skipped = []
    for (const f of contextInitFilesFor(cwdRoot)) {
      let exists = false
      try {
        await fs.access(f.path)
        exists = true
      } catch {
        exists = false
      }
      if (exists && options.force !== true) {
        skipped.push(f.path)
        continue
      }
      await fs.mkdir(resolve(f.path, '..'), { recursive: true })
      await fs.writeFile(f.path, f.body, 'utf8')
      written.push(f.path)
    }
    for (const p of written) process.stdout.write(`wrote ${p}\n`)
    for (const p of skipped) process.stdout.write(`skipped ${p} (--force to overwrite)\n`)
  }
  return 0
}
