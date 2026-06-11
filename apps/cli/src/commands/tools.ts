/**
 * `lumen tools` — list and describe registered tools.
 *
 * Sub-commands:
 *   - `list`  (default): one row per registered tool (name, version, risk).
 *   - `show <name>`: full descriptor for one tool (name, description,
 *     risk class, input JSON Schema).
 *   - `check`: list tools whose `risk` is `approval-required` and that
 *     would prompt at runtime, with a hint about how to disable that
 *     via `config.tools.dangerousRequireApproval`.
 *
 * This command uses the *default* tool palette (filesystem + shell +
 * git + meta + github). It does **not** read MCP server tools; those
 * are only wired after `buildAgent` runs and require live connections.
 * Operators who want to inspect MCP-registered tools should use
 * `lumen doctor` (which does a connect round-trip).
 */

import { BUILT_IN_TOOLSETS, createDefaultTools } from '@lumen/tools'

export interface ToolsListOptions {
  /** Optional flag — only show tools that require approval. */
  readonly approvalRequiredOnly?: boolean
  /** Show toolsets instead of individual tools. */
  readonly toolset?: boolean
}

/** Options for `lumen tools show`. */
export interface ToolsShowOptions {
  readonly name: string
}

/**
 * `lumen tools list` — print every tool the CLI ships by default.
 * Each tool is printed on its own line as: `name  v<version>  risk=<risk>`.
 */
export const toolsListCommand = async (opts: ToolsListOptions = {}): Promise<number> => {
  if (opts.toolset) return toolsToolsetCommand()

  const tools = createDefaultTools()
  const filtered = opts.approvalRequiredOnly
    ? tools.filter((t) => t.describe().risk === 'approval-required')
    : tools

  process.stdout.write(`Lumen tools (${filtered.length}/${tools.length})\n\n`)
  if (filtered.length === 0) {
    process.stdout.write('  No tools matched.\n')
    return 0
  }

  for (const tool of filtered) {
    const desc = tool.describe()
    process.stdout.write(`  ${desc.name.padEnd(14)} v${desc.version.padEnd(6)} risk=${desc.risk}\n`)
  }
  return 0
}

/**
 * `lumen tools --toolset` — list every built-in toolset.
 */
const toolsToolsetCommand = async (): Promise<number> => {
  process.stdout.write(`Lumen toolsets (${BUILT_IN_TOOLSETS.length})\n\n`)
  for (const ts of BUILT_IN_TOOLSETS) {
    process.stdout.write(`  ${ts.id.padEnd(10)} ${ts.name}\n`)
    process.stdout.write(`            ${ts.description}\n`)
  }
  return 0
}

/**
 * `lumen tools show <name>` — print full descriptor for one tool.
 * Prints the JSON Schema for inputs so users can pipe it into
 * agentic tool-calling definitions.
 */
export const toolsShowCommand = async (opts: ToolsShowOptions): Promise<number> => {
  const tools = createDefaultTools()
  const match = tools.find((t) => t.name === opts.name)
  if (!match) {
    process.stderr.write(`Tool not found: ${opts.name}\n`)
    process.stderr.write(`  known: ${tools.map((t) => t.name).join(', ')}\n`)
    return 1
  }
  const desc = match.describe()
  process.stdout.write(`${desc.name}  v${desc.version}\n`)
  process.stdout.write(`  risk:        ${desc.risk}\n`)
  if (desc.description) process.stdout.write(`  description: ${desc.description}\n`)
  process.stdout.write(`  inputSchema:\n`)
  process.stdout.write(`${JSON.stringify(desc.inputJsonSchema, null, 2)}\n`)
  return 0
}

/**
 * `lumen tools check` — short audit listing of approval-required tools
 * so operators can audit their security surface without scanning the
 * whole list. Exits 0 if no approval-required tools, 1 otherwise —
 * designed to be usable in a CI gate.
 */
export const toolsCheckCommand = async (): Promise<number> => {
  const tools = createDefaultTools()
  const dangerous = tools.filter((t) => t.describe().risk === 'approval-required')

  process.stdout.write(`Lumen tools — approval audit\n\n`)
  if (dangerous.length === 0) {
    process.stdout.write('  No approval-required tools in the default palette.\n')
    return 0
  }
  for (const t of dangerous) {
    const desc = t.describe()
    process.stdout.write(`  ${desc.name.padEnd(14)} v${desc.version}\n`)
  }
  process.stdout.write(
    `\n  ${dangerous.length} tool(s) require user approval at runtime.\n  Set config.tools.dangerousRequireApproval=false to skip prompts (not recommended).\n`,
  )
  return 1
}
