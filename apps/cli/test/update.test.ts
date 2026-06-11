/** Tests for `lumen update` command handlers. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  updateCheckCommand,
  updatePrintVersionCommand,
} from '../src/commands/update.js'

let stdout = ''

beforeEach(() => {
  stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('updatePrintVersionCommand', () => {
  it('prints a version string', async () => {
    const code = await updatePrintVersionCommand()
    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('updateCheckCommand', () => {
  it('prints current and latest versions', async () => {
    const code = await updateCheckCommand()
    expect(code === 0 || code === 1).toBe(true)
    expect(stdout).toContain('Lumen update check')
    expect(stdout).toContain('current:')
    expect(stdout).toContain('latest:')
  })

  it('reports (unknown) when no git tags are present', async () => {
    // /tmp is not a git checkout, so the git describe call
    // fails and we get the (unknown) branch.
    const code = await updateCheckCommand({ cwd: '/tmp' })
    expect(code).toBe(0)
    expect(stdout).toContain('(unknown')
  })

  it('respects --quiet when on the latest version', async () => {
    // Without --quiet, equal versions print "You are on the
    // latest version." With --quiet, they should not. We can
    // only assert the negative case here because the
    // workspace does have a git tag, but we exercise the
    // option plumbing.
    const code = await updateCheckCommand({ quiet: true })
    expect(code === 0 || code === 1).toBe(true)
    if (code === 0) {
      expect(stdout).not.toContain('You are on the latest')
    }
  })
})
