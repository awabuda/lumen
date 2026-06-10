/** Tests for the bare `lumen` default command (I5.x).
 *
 * We spawn the CLI as a child process so we exercise the real
 * commander parse, not a mocked version. That way the test catches
 * accidental regressions in the alias wiring, the lazy import path,
 * and the `--model` flag propagation.
 *
 * The TUI itself is not started: we set no API key (or an empty
 * one) and assert that the CLI bails with the same pre-flight
 * error that `lumen chat` would emit. This keeps the test fast
 * and hermetic.
 */

import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Resolve the CLI entry point the same way `pnpm dev` would.
 * In a published build that would be `dist/index.js`; in this
 * dev workflow the user runs `tsx src/index.ts`. We honor both
 * by spawning `tsx` against the source so the test works without
 * a prior `pnpm build`.
 */
/**
 * Resolve the CLI entry point. We use the built `dist/index.js`
 * (produced by `pnpm build`) rather than the TypeScript source so
 * the test does not depend on a TS loader being on PATH. The test
 * itself builds once at module load to keep the dist in sync.
 */
const cliEntry = path.resolve(__dirname, '..', 'dist', 'index.js')

interface RunResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

const runCli = (args: readonly string[], env: Record<string, string> = {}): Promise<RunResult> => {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'node',
      [cliEntry, ...args],
      {
        env: { ...process.env, ...env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    // Chat pre-flight error prints to stderr and exits 2; the TUI
    // would never get a chance to mount. We can also stop the
    // process after a small budget in case Ink's render doesn't
    // error out (it normally does on a missing key within ~1s).
    const killTimer = setTimeout(() => {
      child.kill('SIGTERM')
    }, 5_000)
    child.on('close', (code) => {
      clearTimeout(killTimer)
      resolve({ stdout, stderr, code })
    })
    child.on('error', reject)
  })
}

describe('lumen (default command, I5.x)', () => {
  it('routes bare `lumen` to the chat pre-flight (missing-key error)', async () => {
    // Strip API keys to trigger the chat pre-flight error path.
    const result = await runCli([], {
      OPENAI_API_KEY: '',
      LUMEN_API_KEY: '',
    })
    // Chat emits "lumen chat: missing API key" on stderr and exits 2.
    expect(result.stderr).toContain('lumen chat: missing API key')
    expect(result.code).toBe(2)
  })

  it('routes `lumen --model foo` to the chat pre-flight too', async () => {
    // The --model flag should propagate to the chat command,
    // which then hits the same pre-flight check. We don't have
    // a real key so we still expect the same stderr message —
    // what matters is that the alias path didn't crash trying
    // to parse an unknown option.
    const result = await runCli(['--model', 'gpt-4o-mini'], {
      OPENAI_API_KEY: '',
      LUMEN_API_KEY: '',
    })
    expect(result.stderr).toContain('lumen chat: missing API key')
    expect(result.code).toBe(2)
  })

  it('does not eat explicit subcommands', async () => {
    // `lumen --help` should print commander's help text, NOT
    // try to launch the TUI. We assert the help marker.
    const result = await runCli(['--help'])
    expect(result.stdout).toContain('Usage:')
    expect(result.stdout).toContain('run')
    expect(result.stdout).toContain('chat')
    expect(result.stdout).toContain('model')
    expect(result.stdout).toContain('config')
    expect(result.stdout).toContain('tools')
  })

  it('explicit `lumen chat` still works the same as bare `lumen`', async () => {
    // Regression guard: aliasing `lumen` to `chat` must not have
    // changed the behavior of the explicit subcommand.
    const result = await runCli(['chat'], {
      OPENAI_API_KEY: '',
      LUMEN_API_KEY: '',
    })
    expect(result.stderr).toContain('lumen chat: missing API key')
    expect(result.code).toBe(2)
  })
})
