/**
 * P31.7 — CLAUDE.md / TOOLS.md starter templates written by
 * `lumen init --with-context`. The TOOLS template's body
 * carries the §1.10 disclaimer that pins the
 * "prompt-vs-runtime precedence" rule: the live
 * `request.tools` registry overrides anything the LLM
 * reads here. Operators pasting this into a fresh project
 * accept that contract as the default.
 */

import { join } from 'node:path'

/** Path layout: write alongside the cwd's `.lumen/` (the cwd's
 * AGENTS.md / CLAUDE.md walk-up target, P31.3 P1). */
export const defaultContextDir = (cwd: string): string => join(cwd, '.lumen')

export const starterAgentsMdPath = (cwd: string): string => join(defaultContextDir(cwd), 'AGENTS.md')

export const starterToolsTemplatePath = (cwd: string): string =>
  join(defaultContextDir(cwd), 'TOOLS.md')

/**
 * CLAUDE.md / AGENTS.md starter. Mirrors the §1.2 P1 contract:
 * descriptive project notes the LLM should treat as guidance,
 * not as policy. Operators are expected to edit this file to
 * describe their codebase conventions.
 */
export const starterAgentsMd = (): string => `# Project notes for the Lumen agent (P1).

This file is read at every conversation turn (P31 §1.2 P1
walk-up from the cwd to git root). It is *descriptive
guidance*, not policy — for hard gates see the live
\`request.tools\` registry, the per-tool ToolRisk rating
(\`safe\` / \`approval-required\` / \`dangerous\`), and the
permission policy file pointed at by
\`LUMEN_PERMISSIONS_PATH\`.

## Conventions

Replace this section with project-specific notes the LLM
should remember between turns:

- Build system: …
- Code style: …
- Test runner: …
- Reviewer notes: …

## What *not* to put here

- Tool schemas (the live \`request.tools\` payload is
  authoritative — §1.10 of the design doc).
- Approval / ToolRisk decisions (those are runtime paths;
  putting them here would invite the LLM to ignore the
  live config).
- Secrets (use a real secret store; the agent's runtime
  reads them through \`process.env\`).
`

/**
 * TOOLS.md starter. Mandatory G1 disclaimer per design doc
 * §1.10: the prose here is *guidance*; the live
 * \`request.tools\` registry + ToolRisk dispatch override any
 * divergence. The starter ships this disclaimer at the top so
 * the operator does not need to discover it via diff churn.
 */
export const starterToolsMd = (): string => `# Tooling guidance for the Lumen agent (G1).

This file is loaded by P31 §1.2 G1 walk-up (cwd → git root)
and prepended to every conversation's stable system-prompt
prefix. Like AGENTS.md, it is *descriptive guidance*, not
policy — see the live \`request.tools\` registry and
ToolRisk rating (safe / approval-required / dangerous) for
the authoritative shapes.

## ⚠️ Prompt is descriptive, runtime is authoritative

The names + descriptions below are hints. When the live
\`request.tools\` registry disagrees with this file, the
runtime wins. Do not assume a tool's input shape is valid
because this file describes it; if the model gets a 400
from the provider, it is usually because the schema has
drifted.

## Common tools (the runtime may add or remove)

- \`read_file\` (safe): read a single file by absolute path.
- \`list_dir\` (safe): list a directory.
- \`search_files\` (safe): ripgrep-style content search.
- \`terminal\` (dangerous): run a shell command. Requires
  per-call approval by default; see permissions policy.
- \`write_file\` / \`patch\` (approval-required): edit a file.
  Requires approval unless the tool is on the \`allow\` list.
- \`web_browser\` / \`computer_use\` (approval-required):
  opt-in tools; the agent does not load them unless the
  composition root configured them.

For the live list + per-tool ToolRisk + approval rate, run
\`lumen doctor\`.
`

/** Init template paths lookup, exposed for test introspection. */
export const contextInitFilesFor = (cwd: string): ReadonlyArray<{
  readonly path: string
  readonly body: string
}> => [
  { path: starterAgentsMdPath(cwd), body: starterAgentsMd() },
  { path: starterToolsTemplatePath(cwd), body: starterToolsMd() },
]
