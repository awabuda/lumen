/** Tests for the Docker sandbox. */

import { describe, expect, it } from 'vitest'
import { DockerSandbox } from '../src/shell/docker-sandbox.js'

describe('DockerSandbox.buildArgs', () => {
  it('generates the expected default args for a simple command', () => {
    const sandbox = new DockerSandbox()
    const args = sandbox.buildArgs('echo hello')
    expect(args[0]).toBe('run')
    expect(args[1]).toBe('--rm')
    expect(args).toContain('--network=none')
    expect(args).toContain('--read-only')
    expect(args).toContain('--security-opt=no-new-privileges')
    expect(args).toContain('--cpus')
    expect(args).toContain('--memory')
    expect(args).toContain('--pids-limit')
    const lastThree = args.slice(-3)
    expect(lastThree[0]).toBe('sh')
    expect(lastThree[1]).toBe('-c')
    expect(lastThree[2]).toBe('echo hello')
    // Image is before sh -c.
    expect(args[args.length - 4]).toBe('node:20-alpine')
  })

  it('allows network when configured', () => {
    const sandbox = new DockerSandbox({ allowNetwork: true })
    const args = sandbox.buildArgs('curl example.com')
    expect(args).not.toContain('--network=none')
  })

  it('uses a custom image', () => {
    const sandbox = new DockerSandbox({ image: 'ubuntu:22.04' })
    const args = sandbox.buildArgs('ls')
    expect(args).toContain('ubuntu:22.04')
  })

  it('appends extra flags', () => {
    const sandbox = new DockerSandbox({ extraFlags: ['-e', 'FOO=bar'] })
    const args = sandbox.buildArgs('env')
    expect(args).toContain('-e')
    expect(args).toContain('FOO=bar')
  })

  it('respects custom resource limits', () => {
    const sandbox = new DockerSandbox({ cpus: 2, memory: '512m', pidsLimit: 128 })
    const args = sandbox.buildArgs('true')
    const cpusIdx = args.indexOf('--cpus')
    expect(args[cpusIdx + 1]).toBe('2')
    const memIdx = args.indexOf('--memory')
    expect(args[memIdx + 1]).toBe('512m')
    const pidsIdx = args.indexOf('--pids-limit')
    expect(args[pidsIdx + 1]).toBe('128')
  })
})

describe('DockerSandbox.run (refusal path)', () => {
  it('refuses an empty command array', async () => {
    const sandbox = new DockerSandbox()
    const outcome = await sandbox.run({
      command: [],
      cwd: '/tmp',
      env: {},
      timeoutMs: 5000,
      signal: new AbortController().signal,
    })
    expect(outcome.kind).toBe('refused')
  })
})
