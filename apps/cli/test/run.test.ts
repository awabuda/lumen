/**
 * Tests for the composition root and the `run` command. We use a
 * stubbed `process.stdout.write` / `process.stderr.write` so the tests
 * can assert on what the CLI prints.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCommand } from '../src/commands/run.js'

const captureProcess = (): { stdout: string[]; stderr: string[]; restore: () => void } => {
  const stdout: string[] = []
  const stderr: string[] = []
  const originalStdout = process.stdout.write.bind(process.stdout)
  const originalStderr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    stdout,
    stderr,
    restore: () => {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    },
  }
}

describe('runCommand', () => {
  let capture: ReturnType<typeof captureProcess>
  let originalKey: string | undefined

  beforeEach(() => {
    capture = captureProcess()
    originalKey = process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.LUMEN_API_KEY
  })

  afterEach(() => {
    capture.restore()
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey
  })

  it('returns exit code 2 with a friendly error when no API key is set', async () => {
    const code = await runCommand({ prompt: 'hello' })
    expect(code).toBe(2)
    expect(capture.stderr.join('')).toMatch(/missing API key/i)
  })

  it('exits with a non-2 code (provider error) when API key is provided but base URL is unreachable', async () => {
    // We don't actually hit the network; the test verifies that the
    // "missing API key" pre-flight check is bypassed.
    // Without network, the provider call will throw — that's exit 1.
    const code = await runCommand({
      prompt: 'hi',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1', // nothing listens here
    })
    expect(code).not.toBe(2)
  })
})

// Quiet a vitest warning about unhandled handlers from commander parsing.
vi.setConfig({ testTimeout: 10_000 })
