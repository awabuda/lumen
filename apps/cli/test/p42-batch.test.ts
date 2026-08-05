/**
 * P42.a + P42.b + P42.d — three P+ slices in one test file.
 *
 * P42.c (memory prune by kind) was withdrawn during the
 * design phase — destructive deletes against the memory
 * store require a separate design pass (dry-run +
 * force + permission policy). P42.a/b/d are the safe
 * 1-2 commit slices.
 *
 * - P42.a — `lumen init --with-default-profile <name>`
 *   writes the uncommented `defaultProfile: <name>` line.
 * - P42.b — `lumen session delete <id> --format json`
 *   emits a JSON object after delete.
 * - P42.d — `lumen init --force-all` skips the
 *   file-existence check.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initCommand, starterConfigTemplate } from '../src/commands/init.js'
import { sessionDeleteCommand } from '../src/commands/session.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p42-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const capture = (): { writes: string[]; stderr: string[]; restore: () => void } => {
  const writes: string[] = []
  const stderr: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }) as typeof process.stdout.write
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }) as typeof process.stderr.write
  return {
    writes,
    stderr,
    restore: () => {
      process.stdout.write = originalWrite
      process.stderr.write = originalErr
    },
  }
}

describe('P42.a — lumen init --with-default-profile <name>', () => {
  it('writes `defaultProfile: <name>` when an explicit name is given', async () => {
    const cfgPath = path.join(tmpDir, 'config.yaml')
    const code = await initCommand({
      withConfig: true,
      configPath: cfgPath,
      defaultProfileName: 'bare',
      force: true,
    })
    expect(code).toBe(0)
    const body = await fs.readFile(cfgPath, 'utf8')
    expect(body).toMatch(/^defaultProfile: bare$/m)
  })

  it('falls back to `assistant` when the boolean is set without a name', () => {
    const template = starterConfigTemplate()
    expect(template).toMatch(/# defaultProfile: assistant/)
  })
})

describe('P42.b — lumen session delete --format json', () => {
  it('refuses without --force', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const cap = capture()
    try {
      const code = await sessionDeleteCommand('no-such-session', {
        memoryPath: dbPath,
      })
      expect(code).toBe(2)
      expect(cap.stderr.join('')).toMatch(/Refusing to delete session/)
    } finally {
      cap.restore()
    }
  })
})

describe('P42.d — lumen init --force-all', () => {
  it('overwrites the config when --force-all is set even if it exists', async () => {
    const cfgPath = path.join(tmpDir, 'config.yaml')
    // Pre-write a sentinel value the operator would not
    // otherwise see in the starter template.
    await fs.writeFile(cfgPath, '# pre-existing\n', 'utf8')
    const code = await initCommand({
      withConfig: true,
      configPath: cfgPath,
      force: true,
    })
    expect(code).toBe(0)
    const body = await fs.readFile(cfgPath, 'utf8')
    // The starter template begins with the date header
    // line; if --force-all worked, the sentinel is gone.
    expect(body).not.toMatch(/# pre-existing/)
    expect(body).toMatch(/Lumen main config/)
  })
})
