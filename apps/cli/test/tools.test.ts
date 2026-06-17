/** Tests for `lumen tools` command handlers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toolsCheckCommand, toolsListCommand, toolsShowCommand } from '../src/commands/tools.js'

let stdout = ''
let stderr = ''

beforeEach(() => {
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('toolsListCommand', () => {
  it('prints every default tool', async () => {
    const code = await toolsListCommand()
    expect(code).toBe(0)
    expect(stdout).toContain('Lumen tools')
    // Some well-known tools that ship in the default palette
    expect(stdout).toContain('read_file')
    expect(stdout).toContain('write_file')
    expect(stdout).toContain('terminal')
    expect(stdout).toContain('git')
    expect(stdout).toContain('date')
    expect(stdout).toContain('gh')
  })

  it('filters to approval-required tools when flag is set', async () => {
    const code = await toolsListCommand({ approvalRequiredOnly: true })
    expect(code).toBe(0)
    // patch, git, gh are approval-required; their presence means the filter is working
    expect(stdout).toContain('patch')
    expect(stdout).toContain('git')
    expect(stdout).toContain('gh')
    // safe tools like `date` should NOT appear in the filtered listing
    expect(stdout).not.toMatch(/^ {2}date /m)
  })

  it('--toolset lists built-in toolsets', async () => {
    const code = await toolsListCommand({ toolset: true })
    expect(code).toBe(0)
    expect(stdout).toContain('Lumen toolsets')
    expect(stdout).toContain('fs')
    expect(stdout).toContain('meta')
    expect(stdout).toContain('github')
  })
})

describe('toolsShowCommand', () => {
  it('prints a full descriptor for a known tool', async () => {
    const code = await toolsShowCommand({ name: 'date' })
    expect(code).toBe(0)
    expect(stdout).toContain('date')
    expect(stdout).toContain('risk:')
    expect(stdout).toContain('inputSchema:')
  })

  it('returns 1 for missing tool and lists known tools', async () => {
    const code = await toolsShowCommand({ name: 'no-such-tool' })
    expect(code).toBe(1)
    expect(stderr).toContain('Tool not found')
    expect(stderr).toContain('known:')
    expect(stderr).toContain('read_file')
  })
})

describe('toolsCheckCommand', () => {
  it('lists approval-required tools and exits 1', async () => {
    const code = await toolsCheckCommand()
    expect(code).toBe(1)
    expect(stdout).toContain('approval audit')
    expect(stdout).toContain('require user approval')
  })
})
