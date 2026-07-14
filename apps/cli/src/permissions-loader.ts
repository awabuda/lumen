/**
 * P22.2 — load a tool-permission policy from a YAML file.
 *
 * Why hand-rolled (no `js-yaml` dep):
 *   - The policy file has a small, fixed shape: `version`,
 *     `default`, and a list of rules with `name`, `tools[]`,
 *     `decision`, and optional `when.argMatches`. A bespoke
 *     parser keeps the surface tight and the Zod schema
 *     remains the single source of truth for validation.
 *   - Lumen's CLI has no other YAML dep. Adding one would
 *     bloat the bundle and create a security-review surface
 *     (yaml.load can run code via custom constructors in
 *     some libs).
 *
 * Format (matches the schema in
 * `packages/core/src/agent/middleware/tool-permission.ts`):
 *
 *   version: 1
 *   default: ask          # allow | deny | ask
 *   rules:
 *     - name: allow-read-file
 *       tools: [read_file]
 *       decision: allow
 *     - name: deny-shell
 *       tools: [terminal]
 *       decision: deny
 *     - name: read-md-only
 *       tools: [read_file]
 *       decision: allow
 *       when:
 *         argMatches:
 *           path: \.md$
 *
 * Comments (`#`) and blank lines are allowed. The parser
 * is intentionally tiny: it understands top-level scalars,
 * one level of `rules:`, and `tools: [a, b]` lists. Anything
 * else lands at the Zod parse step with a clear error.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ConfigError, type ToolPermissionPolicy, ToolPermissionPolicySchema } from '@lumen/core'

/** Read a YAML policy file from disk and return the parsed object. */
export const loadPermissionPolicyFromFile = async (
  policyPath: string,
): Promise<ToolPermissionPolicy> => {
  const resolved = path.resolve(policyPath)
  let text: string
  try {
    text = await fs.readFile(resolved, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`permission policy file not found: ${resolved}`, {
        field: 'permissionsPath',
      })
    }
    throw err
  }
  return parsePermissionPolicy(text)
}

/** Parse the YAML text into a {@link ToolPermissionPolicy}. Throws on shape errors. */
export const parsePermissionPolicy = (text: string): ToolPermissionPolicy => {
  const parsed = parseSimpleYaml(text)
  const result = ToolPermissionPolicySchema.safeParse(parsed)
  if (!result.success) {
    const lines = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n')
    throw new ConfigError(`permission policy file is not a valid ToolPermissionPolicy:\n${lines}`, {
      field: 'permissions',
    })
  }
  return result.data
}

/**
 * Tiny YAML subset parser. Recognises the surface described
 * in the file-level comment: scalars (`a: 1`, `a: hi`), one
 * nested list of maps (`rules: - name: x - tools: [a, b]`),
 * and `key: [v1, v2]` inline lists. Anything else is a parse
 * error. The output is plain JSON; the Zod schema then
 * converts + validates.
 *
 * This is not a full YAML parser. It is the smallest parser
 * that handles the P22 policy shape and nothing more.
 */
const parseSimpleYaml = (text: string): unknown => {
  const lines = text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '')) // strip trailing # comments
    .map((line) => line.replace(/\s+$/, '')) // strip trailing ws
    .filter((line) => line.length > 0)
  if (lines.length === 0) return {}

  // Two-pass: first pass finds the top-level structure, second
  // pass materialises the values. The structure is known to
  // be at most 3 levels deep (top → rules → rule fields).
  // We hand-parse because the spec is small and a real YAML
  // library would bloat the CLI bundle.

  type Indent = number
  const out: Record<string, unknown> = {}
  // A tiny stack of containers so `key: value` lines know
  // where to land. Each entry is the container + the key
  // path that the next value should land at.
  const stack: Array<{
    container: Record<string, unknown> | unknown[]
    indent: Indent
    key: string | null
  }> = [{ container: out, indent: -1, key: null }]

  const top = (): {
    container: Record<string, unknown> | unknown[]
    indent: Indent
    key: string | null
  } => stack[stack.length - 1]!

  const parseValue = (raw: string): unknown => {
    const value = raw.trim()
    if (value === 'true') return true
    if (value === 'false') return false
    if (value === '' || value === 'null' || value === '~') return null
    if (/^-?\d+$/.test(value)) return Number(value)
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) return value.slice(1, -1)
    if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      if (inner.length === 0) return []
      return inner.split(',').map((item) => parseValue(item))
    }
    return value
  }

  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    const indent = line.match(/^ */)?.[0].length ?? 0
    // Pop the stack until indent fits.
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop()
    }
    const topFrame = top()
    if (line.trimStart().startsWith('- ')) {
      // List item line. It must be inside a list container.
      const value = line.trimStart().slice(2)
      const innerContainer = topFrame.container
      if (!Array.isArray(innerContainer)) {
        throw new Error(
          `permission policy parse error: '-' without a list at indent ${indent}: ${line}`,
        )
      }
      // The list item may itself contain a key/value (`- name: x`)
      // or it may be a plain scalar.
      const itemMatch = value.match(/^([\w$]+):\s*(.*)$/)
      if (itemMatch) {
        const key = itemMatch[1]!
        const rest = itemMatch[2] ?? ''
        const item: Record<string, unknown> = {}
        item[key] = rest.length > 0 ? parseValue(rest) : null
        innerContainer.push(item)
        if (rest.length === 0) {
          stack.push({ container: item, indent, key: null })
        } else {
          // The key: value is on the same line, but more
          // child keys (e.g. `tools:`) may follow. Push the
          // item onto the stack so they can land.
          stack.push({ container: item, indent, key: null })
        }
      } else {
        innerContainer.push(parseValue(value))
      }
      continue
    }
    // `key: value` (or `key:` for nested block).
    const m = line.match(/^\s*([\w$]+):(?:\s+(.*))?$/)
    if (!m) {
      throw new Error(`permission policy parse error: cannot parse line: ${line}`)
    }
    const key = m[1]!
    const rest = m[2] ?? ''
    const container = topFrame.container
    if (!Array.isArray(container) && typeof container === 'object' && container !== null) {
      if (rest.length > 0) {
        container[key] = parseValue(rest)
      } else {
        // The nested block could be a list (the next line starts
        // with `- `) or an object. We don't know yet, so we
        // default to object. If a subsequent `- ` line lands
        // here, the list-item branch will replace this entry
        // with an array. To keep the surface small we instead
        // use a sentinel: assume object and let the consumer
        // decide. The P22 policy file only has object-shaped
        // rules for `when:` (argMatches) and list-shaped rules
        // for `rules:`. The order matters: `when:` is always
        // a child of a list item, not a child of the top level.
        // For the top level we always expect `default:`,
        // `version:`, and `rules:` (a list). So we can default
        // to array when the key is `rules`, and object
        // otherwise.
        if (key === 'rules') {
          const list: unknown[] = []
          container[key] = list
          stack.push({ container: list, indent, key: null })
        } else {
          const nested: Record<string, unknown> = {}
          container[key] = nested
          stack.push({ container: nested, indent, key: null })
        }
      }
    } else {
      throw new Error(`permission policy parse error: unexpected key '${key}' at indent ${indent}`)
    }
  }

  return out
}
