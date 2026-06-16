/**
 * `write_file` — write text to a file, optionally atomically.
 *
 * Atomic mode (the default) writes to `<path>.tmp` and then renames the
 * temporary file over the target. This guarantees that concurrent
 * readers see either the previous contents or the new contents — never
 * a half-written file. The temporary file is cleaned up on failure.
 *
 * Non-atomic mode writes directly via `fs.writeFile` (faster, useful
 * for non-critical files like caches).
 */

import * as fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AbortError, BaseTool, type ToolContext, type ToolDescriptor } from '@lumen/core'

/** Zod schema for the tool's input. */
export const WriteFileInputSchema = z.object({
  /** File path, resolved against `ctx.cwd` if relative. */
  path: z.string().min(1),
  /** UTF-8 content to write. Empty string is allowed. */
  content: z.string(),
  /** When true (default), write to a `.tmp` file and rename. */
  atomic: z.boolean().optional(),
})
export type WriteFileInput = z.infer<typeof WriteFileInputSchema>

/** Zod schema for the tool's output. */
export const WriteFileOutputSchema = z.object({
  /** Number of bytes written (UTF-8 byte length of `content`). */
  bytesWritten: z.number().int().min(0),
  /** Absolute path that was written. */
  path: z.string(),
})
export type WriteFileOutput = z.infer<typeof WriteFileOutputSchema>

/**
 * Write a file atomically: write to `<path>.tmp`, then rename over the
 * target. Cleans up the temp file on failure. Returns the number of
 * bytes written.
 *
 * Exported for use by {@link PatchTool}, which also needs atomic writes.
 */
export async function atomicWriteFile(
  absPath: string,
  content: string,
  signal: AbortSignal,
): Promise<number> {
  const tmpPath = `${absPath}.tmp`
  const bytes = Buffer.byteLength(content, 'utf8')
  // Ensure parent directory exists; mkdir({ recursive: true }) is a no-op
  // if it already does.
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  try {
    if (signal.aborted) throw new AbortError()
    await fs.writeFile(tmpPath, content, 'utf8')
    if (signal.aborted) {
      await safeUnlink(tmpPath)
      throw new AbortError()
    }
    await fs.rename(tmpPath, absPath)
  } catch (err) {
    await safeUnlink(tmpPath)
    throw err
  }
  return bytes
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p)
  } catch {
    // Best-effort cleanup; ignore missing files.
  }
}

/** Tool: write a file, with an optional atomic mode. */
export class WriteFileTool extends BaseTool {
  public readonly name = 'write_file'
  public readonly description =
    'Write text content to a file. By default, writes atomically (writes to a .tmp file then renames) ' +
    'so concurrent readers never see a half-written file. Set atomic=false to skip the rename step. ' +
    'Overwrites existing files.'
  public readonly inputSchema: z.ZodType<unknown> = WriteFileInputSchema
  public readonly risk = 'dangerous' as const
  public override readonly version = '0.1.0'

  protected async execute(input: unknown, ctx: ToolContext): Promise<WriteFileOutput> {
    const { path: userPath, content, atomic } = input as WriteFileInput
    const absPath = path.resolve(ctx.cwd, userPath)
    const useAtomic = atomic ?? true

    if (useAtomic) {
      const bytesWritten = await atomicWriteFile(absPath, content, ctx.signal)
      return { bytesWritten, path: absPath }
    }
    // Non-atomic path
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    if (ctx.signal.aborted) throw new AbortError()
    await fs.writeFile(absPath, content, 'utf8')
    return { bytesWritten: Buffer.byteLength(content, 'utf8'), path: absPath }
  }

  public override describe(): ToolDescriptor {
    return { ...super.describe(), version: this.version }
  }
}
