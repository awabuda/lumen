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
/**
 * The return type of {@link loadPermissionPolicyWithSources}.
 * `policy` is the merged policy; `sources` maps every rule
 * `name` to the absolute path of the file the rule came
 * from. Use this to render the per-rule source in
 * `lumen permissions show` or in the audit log.
 */
export interface LoadedPermissionPolicy {
  readonly policy: ToolPermissionPolicy
  readonly sources: ReadonlyMap<string, string>
}

/** Read a YAML policy file from disk and return the merged
 *  policy. P22.6.0: when the file declares an `imports:`
 *  list, the loader walks the imports in order, merging
 *  each imported file's `rules`, `autoMode`,
 *  `neverAllowTools`, `hardDenyPatterns`, `allowPatterns`,
 *  and `softDenyPatterns` onto the root policy. Cyclic
 *  imports are a typed `ConfigError`. The root policy's
 *  `default` and `version` win; the imports cannot
 *  override either. */
export const loadPermissionPolicyFromFile = async (
  policyPath: string,
): Promise<ToolPermissionPolicy> => {
  const loaded = await loadPermissionPolicyWithSources(policyPath)
  return loaded.policy
}

/** Same as {@link loadPermissionPolicyFromFile} but also
 *  returns a `sources` map that records the absolute path
 *  of the file each rule came from. P22.6.2: the loader
 *  populates this so `lumen permissions show` can print
 *  the source for every rule in the merged policy. */
export const loadPermissionPolicyWithSources = async (
  policyPath: string,
  options: { readonly visited?: ReadonlySet<string> } = {},
): Promise<LoadedPermissionPolicy> => {
  const resolved = path.resolve(policyPath)
  if (options.visited?.has(resolved) === true) {
    throw new ConfigError(
      `circular policy import: ${resolved} (already visited in this composition)`,
      { field: 'permissions' },
    )
  }
  const visited = new Set<string>([...(options.visited ?? []), resolved])

  let text: string
  try {
    text = await fs.readFile(resolved, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `permission policy file not found: ${resolved}`,
        { field: 'permissionsPath' },
      )
    }
    throw err
  }
  const root = parsePermissionPolicy(text)

  // P22.6.2: track which file each rule came from. The
  // root policy's rules map to the root file's absolute
  // path. Imported rules map to the import's absolute
  // path. After the lockout runs, the surviving rule is
  // whichever one the merge kept.
  const sources = new Map<string, string>()
  for (const rule of root.rules) {
    sources.set(rule.name, resolved)
  }

  if (root.imports.length === 0) {
    return { policy: applyLockout(root, root), sources }
  }

  // Walk the imports in order. Each imported file is
  // recursively loaded; the resulting policies are
  // merged onto the root in declaration order. First match
  // wins inside the merged `rules` array; we keep that
  // invariant by appending imports after the root.
  const merged: ToolPermissionPolicy = {
    version: root.version,
    default: root.default,
    rules: [...root.rules],
    autoMode: root.autoMode,
    imports: [],
    allowOverrides: root.allowOverrides,
  }

  for (const rel of root.imports) {
    const importPath = path.isAbsolute(rel) ? rel : path.resolve(path.dirname(resolved), rel)
    const child = await loadPermissionPolicyWithSources(importPath, { visited })
    merged.rules = [...merged.rules, ...child.policy.rules]
    // The source map takes the imported file's path for
    // every imported rule name. A rule name that was set
    // by an earlier file is NOT overwritten — the first
    // occurrence (the root) wins the source attribution.
    // The P22.6.1 lockout keeps the root's rule on a
    // name collision, so the source must point at the root.
    for (const rule of child.policy.rules) {
      if (!sources.has(rule.name)) {
        sources.set(rule.name, importPath)
      }
    }
    // Arrays concat + dedupe. The neverAllowTools and
    // hardDenyPatterns are deterministic; allowPatterns and
    // softDenyPatterns are audit-only so duplicates are
    // harmless. We dedupe neverAllowTools because the
    // operator may list the same tool in two files. The
    // autoMode block is a single config (last import wins);
    // we surface that decision in the audit log by tracking
    // which import set it.
    if (child.policy.autoMode !== undefined) {
      // Preserve the previous `enabled` flag if the
      // current import does not set it. The root policy
      // can also set `enabled: true`; an import that
      // omits the field inherits the root's value.
      const mergedEnabled = merged.autoMode?.enabled ?? child.policy.autoMode?.enabled ?? false
      const existing = new Set(merged.autoMode?.neverAllowTools ?? [])
      for (const t of child.policy.autoMode?.neverAllowTools ?? []) existing.add(t)
      merged.autoMode = {
        enabled: mergedEnabled,
        neverAllowTools: [...existing],
        hardDenyPatterns: [
          ...(merged.autoMode?.hardDenyPatterns ?? []),
          ...(child.policy.autoMode?.hardDenyPatterns ?? []),
        ],
        allowPatterns: [
          ...(merged.autoMode?.allowPatterns ?? []),
          ...(child.policy.autoMode?.allowPatterns ?? []),
        ],
        softDenyPatterns: [
          ...(merged.autoMode?.softDenyPatterns ?? []),
          ...(child.policy.autoMode?.softDenyPatterns ?? []),
        ],
      }
    }
  }

  const finalPolicy = applyLockout(merged, root)

  // P22.6.1 lockout may have dropped a rule that was in
  // the merged list. Re-attribute the source map: every
  // surviving rule's name maps to its source file. For a
  // rule with the same name in both the root and an
  // import, the lockout kept the root's entry, so the
  // source is the root file. This is the only way to make
  // the source map consistent with the final policy.
  const finalSources = new Map<string, string>()
  for (const rule of finalPolicy.rules) {
    const source = sources.get(rule.name)
    if (source !== undefined) {
      finalSources.set(rule.name, source)
    }
  }

  return { policy: finalPolicy, sources: finalSources }
}

/**
 * P22.6.1: managed-only lockout.
 *
 * On a `name` collision between a root rule and an import
 * rule, the behavior depends on the root's `allowOverrides`
 * flag:
 *
 * - `allowOverrides: false` (the default; the secure
 *   default): the root rule wins. The import rule is
 *   dropped. This is the managed-only lockout — a project /
 *   user file cannot loosen a rule the managed file
 *   explicitly denies. Mirrors Claude Code's
 *   `allowManagedPermissionRulesOnly`.
 *
 * - `allowOverrides: true`: last import wins. The import
 *   rule replaces the root rule. Discouraged for production
 *   but useful for tests.
 *
 * Rules that do not collide with the root pass through
 * unchanged in both modes.
 */
const applyLockout = (
  merged: ToolPermissionPolicy,
  root: ToolPermissionPolicy,
): ToolPermissionPolicy => {
  if (root.allowOverrides === true) {
    // Last-import-wins dedup by name.
    const byName = new Map<string, ToolPermissionPolicy['rules'][number]>()
    for (const rule of merged.rules) {
      byName.set(rule.name, rule)
    }
    return { ...merged, rules: Array.from(byName.values()) }
  }
  // Lockout: build a set of root rule names. Any import
  // rule that collides with a root rule name is dropped
  // (the root wins). Non-colliding import rules pass through.
  const rootNames = new Set(root.rules.map((r) => r.name))
  return {
    ...merged,
    rules: merged.rules.filter((rule, idx, all) => {
      if (!rootNames.has(rule.name)) return true
      // The first occurrence of this name is the root
      // rule (rules are appended root-first). Keep the root
      // rule; drop subsequent entries with the same name.
      const firstIdx = all.findIndex((r) => r.name === rule.name)
      return idx === firstIdx
    }),
  }
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

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
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
        // Decide array vs. object by peeking at the next
        // non-empty line. If it starts with `- `, the block
        // is a list; otherwise an object. The P22 policy
        // file uses both shapes (e.g. `imports:` is a list,
        // `autoMode:` is an object).
        const peekIndent = indent + 2
        const peekLine = lines.slice(i + 1).find((l) => {
          const m2 = l.match(/^( *)/)
          return m2 && m2[1]!.length >= peekIndent && l.trim().length > 0
        })
        const isList = peekLine?.trimStart().startsWith('- ') ?? false
        if (isList) {
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
