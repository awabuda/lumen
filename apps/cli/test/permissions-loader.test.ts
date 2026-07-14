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
