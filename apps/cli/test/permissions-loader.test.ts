/** P22.2 — YAML permission policy loader tests. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ConfigError } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadPermissionPolicyFromFile, parsePermissionPolicy } from '../src/permissions-loader.js'

let workDir = ''

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-perm-'))
})

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true })
})

const writePolicy = async (text: string): Promise<string> => {
  const file = path.join(workDir, 'policy.yaml')
  await fs.writeFile(file, text, 'utf8')
  return file
}

describe('parsePermissionPolicy', () => {
  it('parses the canonical shape (default + rules list with tools + decision)', () => {
    const policy = parsePermissionPolicy(`
version: 1
default: ask
rules:
  - name: allow-read
    tools: [read_file]
    decision: allow
  - name: deny-shell
    tools: [terminal]
    decision: deny
`)
    expect(policy.version).toBe(1)
    expect(policy.default).toBe('ask')
    expect(policy.rules).toHaveLength(2)
    expect(policy.rules[0]?.name).toBe('allow-read')
    expect(policy.rules[0]?.tools).toEqual(['read_file'])
    expect(policy.rules[1]?.decision).toBe('deny')
  })

  it('parses argMatches with a regex string', () => {
    const policy = parsePermissionPolicy(`
version: 1
default: ask
rules:
  - name: allow-md
    tools: [read_file]
    decision: allow
    when:
      argMatches:
        path: \\.md$
`)
    expect(policy.rules[0]?.when?.argMatches).toEqual({ path: '\\.md$' })
  })

  it('accepts inline comment lines and blank lines', () => {
    const policy = parsePermissionPolicy(`
# top-level comment
version: 1

# default-on-miss
default: ask
# rule list
rules:
  - name: r
    tools: [a]
    decision: allow
`)
    expect(policy.rules).toHaveLength(1)
  })

  it('rejects a malformed shape (missing version) with a Zod issue list', () => {
    expect(() =>
      parsePermissionPolicy(`
default: ask
rules: []
`),
    ).toThrow(/not a valid ToolPermissionPolicy/)
  })

  it('rejects an unknown decision', () => {
    expect(() =>
      parsePermissionPolicy(`
version: 1
default: maybe
rules: []
`),
    ).toThrow(/not a valid ToolPermissionPolicy/)
  })

  it('parses an optional autoMode block (P22.5.2)', () => {
    const policy = parsePermissionPolicy(`
version: 1
default: ask
rules: []
autoMode:
  enabled: true
  neverAllowTools: [read_file]
  hardDenyPatterns: ['^terminal$']
`)
    expect(policy.autoMode?.enabled).toBe(true)
    expect(policy.autoMode?.neverAllowTools).toEqual(['read_file'])
    expect(policy.autoMode?.hardDenyPatterns).toEqual(['^terminal$'])
  })

  it('omits the autoMode block when the policy file does not declare one', () => {
    const policy = parsePermissionPolicy(`
version: 1
default: ask
rules: []
`)
    expect(policy.autoMode).toBeUndefined()
  })
})

describe('loadPermissionPolicyFromFile', () => {
  it('reads a real file from disk and returns the parsed policy', async () => {
    const file = await writePolicy(`version: 1
default: ask
rules:
  - name: r1
    tools: [x]
    decision: allow
`)
    const policy = await loadPermissionPolicyFromFile(file)
    expect(policy.default).toBe('ask')
    expect(policy.rules[0]?.name).toBe('r1')
  })

  it('throws a typed ConfigError when the file does not exist', async () => {
    const missing = path.join(workDir, 'no-such.yaml')
    await expect(loadPermissionPolicyFromFile(missing)).rejects.toBeInstanceOf(ConfigError)
  })

  it('throws a typed ConfigError when the file is malformed', async () => {
    const file = await writePolicy('default: ask\nrules: []\n')
    await expect(loadPermissionPolicyFromFile(file)).rejects.toBeInstanceOf(ConfigError)
  })
})

describe('loadPermissionPolicyFromFile imports (P22.6.0)', () => {
  const load = (p: string) => loadPermissionPolicyFromFile(p)

  it('merges rules from a single imported file in declaration order', async () => {
    const root = path.join(workDir, 'root.yaml')
    const child = path.join(workDir, 'child.yaml')
    await fs.writeFile(
      child,
      `version: 1
default: ask
rules:
  - name: child-allow
    tools: [read_file]
    decision: allow
`,
      'utf8',
    )
    await fs.writeFile(
      root,
      `version: 1
default: ask
rules:
  - name: root-allow
    tools: [list_dir]
    decision: allow
imports:
  - ./child.yaml
`,
      'utf8',
    )
    const policy = await load(root)
    expect(policy.rules.map((r) => r.name)).toEqual(['root-allow', 'child-allow'])
  })

  it('walks a deep import chain', async () => {
    const root = path.join(workDir, 'root-deep.yaml')
    const mid = path.join(workDir, 'mid.yaml')
    const leaf = path.join(workDir, 'leaf.yaml')
    await fs.writeFile(
      leaf,
      `version: 1
default: ask
rules:
  - name: leaf
    tools: [read_file]
    decision: allow
`,
      'utf8',
    )
    await fs.writeFile(
      mid,
      `version: 1
default: ask
rules: []
imports:
  - ./leaf.yaml
`,
      'utf8',
    )
    await fs.writeFile(
      root,
      `version: 1
default: ask
rules: []
imports:
  - ./mid.yaml
`,
      'utf8',
    )
    const policy = await load(root)
    expect(policy.rules.map((r) => r.name)).toEqual(['leaf'])
  })

  it('rejects a cyclic import with a typed ConfigError', async () => {
    const a = path.join(workDir, 'cyc-a.yaml')
    const b = path.join(workDir, 'cyc-b.yaml')
    await fs.writeFile(
      a,
      `version: 1
default: ask
rules: []
imports:
  - ./cyc-b.yaml
`,
      'utf8',
    )
    await fs.writeFile(
      b,
      `version: 1
default: ask
rules: []
imports:
  - ./cyc-a.yaml
`,
      'utf8',
    )
    await expect(load(a)).rejects.toThrow(/circular policy import/)
  })

  it('throws when an imported file is missing', async () => {
    const root = path.join(workDir, 'root-missing.yaml')
    await fs.writeFile(
      root,
      `version: 1
default: ask
rules: []
imports:
  - ./no-such.yaml
`,
      'utf8',
    )
    await expect(load(root)).rejects.toThrow(/permission policy file not found/)
  })

  it('last import wins for the autoMode block; neverAllowTools dedupes and hardDenyPatterns concatenate', async () => {
    const root = path.join(workDir, 'root-am.yaml')
    const first = path.join(workDir, 'first-am.yaml')
    const second = path.join(workDir, 'second-am.yaml')
    await fs.writeFile(
      first,
      `version: 1
default: ask
rules: []
autoMode:
  enabled: true
  neverAllowTools: [read_file, terminal]
  hardDenyPatterns: ['^terminal$']
`,
      'utf8',
    )
    await fs.writeFile(
      second,
      `version: 1
default: ask
rules: []
autoMode:
  enabled: true
  neverAllowTools: [read_file, list_dir]
  hardDenyPatterns: ['^write_file$']
`,
      'utf8',
    )
    await fs.writeFile(
      root,
      `version: 1
default: ask
rules: []
imports:
  - ./first-am.yaml
  - ./second-am.yaml
`,
      'utf8',
    )
    const policy = await load(root)
    expect(policy.autoMode?.enabled).toBe(true)
    expect(policy.autoMode?.neverAllowTools.sort()).toEqual(['list_dir', 'read_file', 'terminal'])
    expect(policy.autoMode?.hardDenyPatterns).toEqual(['^terminal$', '^write_file$'])
  })
})
