/**
 * Tests for {@link NoneSandbox}.
 *
 * The `none` strategy is a single-line behaviour ("refuse
 * everything") so we lock it down with one explicit test.
 */

import { describe, expect, it } from 'vitest'
import { defaultShellSandboxConfig } from '../src/shell/factories.js'
import { NoneSandbox } from '../src/shell/none-sandbox.js'
import type { ShellSandboxRequest } from '../src/shell/sandbox.js'

describe('NoneSandbox', () => {
  it('refuses every command with policy-disabled', async () => {
    const sandbox = new NoneSandbox(defaultShellSandboxConfig())
    const req: ShellSandboxRequest = {
      command: ['echo', 'should-not-run'],
      cwd: '/tmp',
      env: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    }
    const outcome = await sandbox.run(req)
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('policy-disabled')
    expect(outcome.message).toMatch(/policy/i)
  })

  it('refuses even an empty argv', async () => {
    const sandbox = new NoneSandbox(defaultShellSandboxConfig())
    const outcome = await sandbox.run({
      command: [],
      cwd: '/tmp',
      env: {},
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('refused')
  })
})
