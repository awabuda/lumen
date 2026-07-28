/**
 * P30.B2 — `lumen apply-patch` CLI e2e.
 *
 * P25.5 shipped the `parsePatch` + `applyPatchPlan` helpers
 * to `@lumen/tools`, but the CLI had no standalone
 * subcommand for them. P30.B2 adds `lumen apply-patch
 * <file>` and `--dry-run` and tests the round-trip via
 * the CLI entry point (the helpers themselves are
 * exercised in `packages/tools/test/p25.5-apply-patch.test.ts`).
 *
 * The tests use a tmp directory + a real on-disk file as
 * the patch target. The CLI does not sandbox; operators
 * are expected to review the patch before running, and
 * `--dry-run` is the safe preview.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyPatchCommand } from '../src/commands/apply-patch.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-apply-patch-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const writeFile = async (rel: string, content: string): Promise<string> => {
  const full = path.join(tmpDir, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf8')
  return full
}

const readFile = async (rel: string): Promise<string> => {
  return fs.readFile(path.join(tmpDir, rel), 'utf8')
}

describe('P30.B2 — lumen apply-patch CLI', () => {
  it('applies a simple create patch', async () => {
    // parsePatch is strict: `*** End Patch` must be the
    // literal final line (no trailing newline), and
    // `*** Add File: <path>` lines must use `+` prefix
    // for content (V4A convention).
    const patchPath = await writeFile(
      'add.patch',
      '*** Begin Patch\n*** Add File: new.txt\n+hello, world\n*** End Patch',
    )
    const code = await applyPatchCommand({ path: patchPath, cwd: tmpDir })
    expect(code).toBe(0)
    // parsePatch strips the trailing `\n` from each `+` line
    // (V4A's +line convention) so the file content is
    // 'hello, world' without a trailing newline.
    expect(await readFile('new.txt')).toBe('hello, world')
  })

  it('applies a delete patch', async () => {
    await writeFile('victim.txt', 'goodbye\n')
    const patchPath = await writeFile(
      'rm.patch',
      '*** Begin Patch\n*** Delete File: victim.txt\n*** End Patch',
    )
    const code = await applyPatchCommand({ path: patchPath, cwd: tmpDir })
    expect(code).toBe(0)
    await expect(readFile('victim.txt')).rejects.toThrow()
  })

  it('applies an update patch (oldText → newText)', async () => {
    // parsePatch treats `-` and `+` lines as exact strings
    // *without* the trailing newline; the on-disk file must
    // match the `oldText` shape exactly. We write
    // 'hello, world' (no \n) so the `-` line matches.
    await writeFile('greet.txt', 'hello, world')
    const patchPath = await writeFile(
      'update.patch',
      '*** Begin Patch\n*** Update File: greet.txt\n@@\n-hello, world\n+hello, lumen\n*** End Patch',
    )
    const code = await applyPatchCommand({ path: patchPath, cwd: tmpDir })
    expect(code).toBe(0)
    expect(await readFile('greet.txt')).toBe('hello, lumen')
  })

  it('--dry-run: parses + plans, does not touch the filesystem', async () => {
    const patchPath = await writeFile(
      'add.patch',
      '*** Begin Patch\n*** Add File: new.txt\n+hi\n*** End Patch',
    )
    const code = await applyPatchCommand({ path: patchPath, dryRun: true, cwd: tmpDir })
    expect(code).toBe(0)
    // The file was not created.
    await expect(readFile('new.txt')).rejects.toThrow()
  })

  it('exits 1 when a hunk fails (oldText does not match on-disk)', async () => {
    await writeFile('greet.txt', 'totally different content\n')
    const patchPath = await writeFile(
      'bad.patch',
      '*** Begin Patch\n*** Update File: greet.txt\n@@\n-hello, world\n+hello, lumen\n*** End Patch',
    )
    const code = await applyPatchCommand({ path: patchPath, cwd: tmpDir })
    expect(code).toBe(1)
    // The file was not modified.
    expect(await readFile('greet.txt')).toBe('totally different content\n')
  })

  it('exits 2 when the patch file is missing', async () => {
    const code = await applyPatchCommand({ path: path.join(tmpDir, 'no-such.patch') })
    expect(code).toBe(2)
  })

  it('exits 2 on a malformed patch', async () => {
    const patchPath = await writeFile('bad.patch', 'this is not a V4A patch')
    const code = await applyPatchCommand({ path: patchPath })
    expect(code).toBe(2)
  })

  it('exits 0 on an empty patch (zero hunks)', async () => {
    const patchPath = await writeFile('empty.patch', '*** Begin Patch\n*** End Patch')
    const code = await applyPatchCommand({ path: patchPath })
    expect(code).toBe(0)
  })
})
