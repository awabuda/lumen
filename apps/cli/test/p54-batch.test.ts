/**
 * P54 — when `lumen` (no arguments) is invoked on
 * a non-TTY stream, the pre-P54 behaviour was to
 * default to the `chat` command, mount the Ink
 * TUI, and immediately throw "Raw mode is not
 * supported on the current process.stdin". P54
 * prints a one-line hint + the help output and
 * exits with code 2.
 *
 * One test exercises the non-TTY path through the
 * `lumen` entry. The exit code is 2 (per `process.exit(2)`)
 * and the stderr contains the "default subcommand" hint.
 */

import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('P54 — lumen no-args non-TTY fallback', () => {
  it('prints a hint + help and exits 2 when stdin is not a TTY', () => {
    const cli = '/Users/chengpengtao/workspace/lumen/apps/cli/dist/index.js'
    // `< /dev/null` ensures `process.stdin.isTTY` is false
    // in the child process. The pre-P54 path threw a
    // stack trace; the P54 path exits cleanly with a
    // helpful message.
    const result = spawnSync('node', [cli], {
      input: '',
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toMatch(/default subcommand/)
    expect(result.stderr).toMatch(/lumen --help/)
  })
})
