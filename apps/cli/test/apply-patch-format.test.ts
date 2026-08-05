import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyPatchCommand } from '../src/commands/apply-patch.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p35-e-'))
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const writePatch = async (rel: string, body: string): Promise<string> => {
  const full = path.join(tmpRoot, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  const wrapped = `*** Begin Patch\n${body}\n*** End Patch`
  await fs.writeFile(full, wrapped, 'utf8')
  return full
}

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

describe('applyPatchCommand --format json — P35.e', () => {
  it('emits a structured JSON object when --dry-run --format json is set', async () => {
    const patchPath = await writePatch(
      'patch.v4a',
      `*** Add File: p35-e/new.txt
+hello world
*** Update File: p35-e/foo.txt
@@
-old
+new
`,
    )
    const cap = capture()
    try {
      const code = await applyPatchCommand({
        path: patchPath,
        dryRun: true,
        format: 'json',
        cwd: tmpRoot,
      })
      expect(code).toBe(0)
      const parsed = JSON.parse(cap.writes.join('')) as {
        dryRun: boolean
        hunks: number
        summary: Array<{ kind: string; filePath: string }>
      }
      expect(parsed.dryRun).toBe(true)
      expect(parsed.hunks).toBe(2)
      expect(parsed.summary).toHaveLength(2)
      const kinds = parsed.summary.map((s) => s.kind).sort()
      expect(kinds).toEqual(['create', 'update'])
    } finally {
      cap.restore()
    }
  })

  it('keeps pre-P35.e dry-run human output when --format is omitted', async () => {
    const patchPath = await writePatch(
      'patch.v4a',
      `*** Add File: p35-e/new.txt
+hello
`,
    )
    const cap = capture()
    try {
      const code = await applyPatchCommand({
        path: patchPath,
        dryRun: true,
        cwd: tmpRoot,
      })
      expect(code).toBe(0)
      const out = cap.writes.join('')
      expect(out).toMatch(/dry-run: 1 hunk\(s\) planned/)
      expect(out).toMatch(/hunk #0: create p35-e\/new\.txt/)
    } finally {
      cap.restore()
    }
  })
})
