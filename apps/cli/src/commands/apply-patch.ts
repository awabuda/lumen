/**
 * P30.B2 — `lumen apply-patch <file>` CLI subcommand.
 *
 * Pre-P30.B2 the apply_patch parser + applier lived in
 * `@lumen/tools` (P25.5) as a tool the agent loop could
 * call, but the CLI had no standalone subcommand for
 * applying a patch from disk. Operators who wanted to
 * drive the patch from a script (CI, dotfile sync, etc.)
 * had to write their own glue.
 *
 * P30.B2 closes it:
 *
 *   - `lumen apply-patch <file>` reads a V4A patch from
 *     `<file>`, parses it, applies it via the filesystem
 *     applier, and reports what was applied / failed.
 *   - `--dry-run` parses + plans but does not touch the
 *     filesystem. Useful for CI checks.
 *   - Exit codes: 0 = all applied, 1 = some failed,
 *     2 = usage error (missing file, parse error).
 *
 * Risk: this command can modify any file the operator's
 * user can write. The CLI does not sandbox the patch.
 * Operators are expected to review the patch file before
 * running; `--dry-run` is the safe preview.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  type PatchApplier,
  type PatchApplyResult,
  PatchParseError,
  type PatchPlan,
  applyPatchPlan,
  parsePatch,
} from '@lumen/tools'

export interface ApplyPatchCommandOptions {
  readonly path: string
  readonly dryRun?: boolean
  /**
   * P35.e — output format. 'human' (default) emits the
   * one-line-per-hunk layout; 'json' emits a single
   * object (CI-friendly).
   */
  readonly format?: 'human' | 'json'
  /**
   * P35.e — when --format json is set, include the
   * raw `PatchPlan` shape in the JSON output. Default
   * false (keep the CI surface compact).
   */
  readonly includePlan?: boolean
  /**
   * Directory relative to which `*** Add File: <path>` and
   * `*** Update File: <path>` paths are resolved. Defaults
   * to `process.cwd()`. Operators who want the patch to
   * touch a specific subdirectory (e.g. a CI run with a
   * dedicated build dir) pass this explicitly.
   */
  readonly cwd?: string
  /**
   * P46.c — when true, suppress the one-line
   * human-path summary (`dry-run: N hunk(s) planned` /
   * `(no hunks applied)` / etc.). Useful in CI when
   * the script only cares about the exit code or
   * the JSON shape (the JSON path is unaffected).
   * Default `false` (pre-P46.c behaviour is the
   * human-friendly summary line).
   */
  readonly quiet?: boolean
}

const fsApplier = (root: string): PatchApplier => ({
  read: (rel) => fs.readFile(path.resolve(root, rel), 'utf8'),
  // P53 — `*** Add File: <path>` writes the file via
  // this applier. Pre-P53 the write call required
  // the parent directory to exist (an `ENOENT` on
  // a missing parent surfaced as a failure in the
  // patch result). The V4A spec is fine with creating
  // new files in new directories; this is the natural
  // place to mkdir. The pre-existing 7 pre-existing
  // failures + 1 tools pre-existing failure remain
  // FENCE-OFF (this fix is a 1-line addition, no
  // schema or interface change).
  write: (rel, content) => {
    const abs = path.resolve(root, rel)
    return fs
      .mkdir(path.dirname(abs), { recursive: true })
      .then(() => fs.writeFile(abs, content, 'utf8'))
  },
  remove: (rel) => fs.unlink(path.resolve(root, rel)),
})

const formatResult = (plan: PatchPlan, result: PatchApplyResult, dryRun: boolean): string => {
  const lines: string[] = []
  const verb = dryRun ? 'would apply' : 'applied'
  if (result.applied.length === 0) {
    lines.push(`(no hunks ${verb})`)
  } else {
    for (const a of result.applied) {
      lines.push(`  ${verb}: ${a.filePath} (${a.kind})`)
    }
  }
  if (result.failed.length > 0) {
    lines.push('failed:')
    for (const f of result.failed) {
      const hunk = plan.hunks[f.index]
      const filePath = hunk?.filePath ?? '<unknown>'
      lines.push(`  hunk #${f.index} (${filePath}): ${f.reason}`)
    }
  }
  return lines.join('\n')
}

export const applyPatchCommand = async (options: ApplyPatchCommandOptions): Promise<number> => {
  const filePath = path.resolve(options.path)
  const cwd = options.cwd !== undefined ? path.resolve(options.cwd) : process.cwd()
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (err) {
    process.stderr.write(`lumen apply-patch: cannot read ${filePath}: ${(err as Error).message}\n`)
    return 2
  }

  let plan: PatchPlan
  try {
    plan = parsePatch(raw)
  } catch (err) {
    if (err instanceof PatchParseError) {
      process.stderr.write(`lumen apply-patch: parse error: ${err.message}\n`)
    } else {
      process.stderr.write(`lumen apply-patch: unexpected error: ${(err as Error).message}\n`)
    }
    return 2
  }

  if (plan.hunks.length === 0) {
    process.stdout.write('(empty patch — nothing to apply)\n')
    return 0
  }

  if (options.dryRun === true) {
    if (options.format === 'json') {
      const summary = plan.hunks.map((h, i) => ({
        index: i,
        kind: h.isCreate ? 'create' : h.isDelete ? 'delete' : 'update',
        filePath: h.filePath,
      }))
      process.stdout.write(
        `${JSON.stringify({ dryRun: true, hunks: plan.hunks.length, summary }, null, 2)}\n`,
      )
      return 0
    }
    // P46.c — `--quiet` suppresses the human-path
    // summary line. The exit code is unaffected.
    if (options.quiet !== true) {
      process.stdout.write(`dry-run: ${plan.hunks.length} hunk(s) planned\n`)
      for (let i = 0; i < plan.hunks.length; i += 1) {
        const hunk = plan.hunks[i]
        if (hunk === undefined) continue
        const kind = hunk.isCreate ? 'create' : hunk.isDelete ? 'delete' : 'update'
        process.stdout.write(`  hunk #${i}: ${kind} ${hunk.filePath}\n`)
      }
    }
    return 0
  }

  let result: PatchApplyResult
  try {
    result = await applyPatchPlan(plan, fsApplier(cwd))
  } catch (err) {
    process.stderr.write(
      `lumen apply-patch: applier error: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 2
  }
  if (options.format === 'json') {
    const payload = {
      dryRun: false,
      hunks: plan.hunks.length,
      applied: result.applied.map((a) => ({ filePath: a.filePath, kind: a.kind })),
      failed: result.failed.map((f) => {
        const hunk = plan.hunks[f.index]
        return {
          index: f.index,
          filePath: hunk?.filePath ?? '<unknown>',
          reason: f.reason,
        }
      }),
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return result.failed.length > 0 ? 1 : 0
  }
  // P46.c — `--quiet` suppresses the human-path
  // summary line on the apply path. The JSON
  // path is unaffected (always emits a JSON
  // object).
  if (options.quiet !== true) {
    process.stdout.write(`${formatResult(plan, result, false)}\n`)
  }
  return result.failed.length > 0 ? 1 : 0
}
