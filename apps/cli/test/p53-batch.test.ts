/**
 * P53 — `lumen apply-patch` fsApplier.write now
 * mkdirSync the parent directory before writing.
 * Pre-P53 the write call required the parent
 * directory to exist; an `ENOENT` on a missing
 * parent surfaced as a failure in the patch
 * result. The V4A spec is fine with creating new
 * files in new directories; this is the natural
 * place to mkdir.
 *
 * The pre-existing 7 pre-existing failures + 1
 * tools pre-existing failure remain FENCE-OFF
 * (this fix is a 1-line addition, no schema or
 * interface change).
 *
 * One test exercises a patch that creates a new
 * file in a non-existent subdirectory. The test
 * uses a real fsApplier in a tmpdir; the patch
 * must succeed.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatchCommand } from '../src/commands/apply-patch.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p53-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('P53 — lumen apply-patch mkdirSync parent', () => {
  it('creates the parent directory for `*** Add File:` in a new subdirectory', async () => {
    const patchPath = path.join(tmpDir, 'create-subdir.patch')
    const patch = [
      '*** Begin Patch',
      '*** Add File: subdir/deeply/nested/file.txt',
      '+hello from P53',
      '*** End Patch',
    ].join('\n')
    await fs.writeFile(patchPath, patch, 'utf8')

    const code = await applyPatchCommand({
      path: patchPath,
      cwd: tmpDir,
      format: 'json',
    })
    expect(code).toBe(0)

    const created = path.join(tmpDir, 'subdir/deeply/nested/file.txt')
    const content = await fs.readFile(created, 'utf8')
    expect(content).toBe('hello from P53')
  })
})
