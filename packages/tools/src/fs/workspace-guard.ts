/**
 * P33.B Day2 — shared FS workspace-root path-guard.
 *
 * Mirrors `docs/OPTIMIZATION-PLAN.md` §2 D2 ("任何对
 * 文件/terminal 工具的 cross-tool 范围 = sandbox 接管
 * FS workspaceRoot path-guard") and the pre-existing
 * `DefaultSandbox.resolveCwd` pattern. The FS tools
 * (`read_file` / `write_file` / `patch` / `list_dir` /
 * `search_files`) accept a `path` argument that the
 * agent can pass arbitrary strings to; without a
 * workspace-root guard, a `..` traversal slips past
 * the tool's `ctx.cwd` resolution. This module provides
 * a single shared resolver so every FS tool enforces
 * the same boundary check.
 *
 * The shell sandbox has a *similar* guard on `request.cwd`
 * (see `DefaultSandbox.resolveCwd`). The two resolve to
 * the same `ConfigError` shape so the agent's per-tool
 * error handling treats them uniformly.
 *
 * The shared check uses a two-step test (string prefix +
 * separator boundary) so `/foo/bar2` does not match
 * `/foo/bar`. Symlink-based escapes are caught at the
 * `fs.realpath` step (callers can opt in to realpath
 * resolution by passing `resolveSymlinks: true`).
 */

import { realpath } from 'node:fs/promises'
import * as path from 'node:path'
import { ConfigError } from '@lumen/core'

/**
 * Resolve a user-supplied `path` argument against a
 * `ctx.cwd` and a `workspaceRoot`, then verify the
 * resolved path is either the workspace root itself or
 * a strict descendant. Throws a typed `ConfigError`
 * with `field: 'path'` on traversal.
 *
 * Pure path-string check; no filesystem I/O unless
 * `options.resolveSymlinks` is set. The check is
 * intentionally string-based (not realpath) for the
 * default path so the guard fires before any IO; the
 * symlink opt-in is for callers that want stronger
 * guarantees at the cost of an `fs.realpath` syscall.
 */
export interface ResolveSafePathOptions {
  /**
   * When true, run `fs.realpath` on the resolved path
   * before the boundary check, so symlink-based escapes
   * are caught. Default: `false` (string-only check; the
   * boundary test still catches `..` and absolute paths
   * outside the root).
   */
  readonly resolveSymlinks?: boolean
}

export const resolveSafePath = async (
  requested: string,
  cwd: string,
  workspaceRoot: string | undefined,
  options: ResolveSafePathOptions = {},
): Promise<string> => {
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    // No workspace root supplied — the composition root
    // forgot to set it. Surface a typed `ConfigError` so the
    // operator notices. We don't silently fall through to a
    // permissive check; the missing-workspaceRoot case is
    // a configuration error per Day2 acceptance criteria.
    throw new ConfigError(
      `Workspace-guard: ctx.workspaceRoot is missing. The composition root must set it before any cross-tool path-guard can run.`,
      { field: 'workspaceRoot' },
    )
  }
  const baseCwd = path.resolve(cwd)
  const resolvedRequested = path.resolve(baseCwd, requested)
  const root = path.resolve(workspaceRoot)
  if (!isInsideRoot(resolvedRequested, root)) {
    throw new ConfigError(
      `Workspace-guard: path "${requested}" (resolved to ${resolvedRequested}) is outside workspaceRoot "${root}". Path-traversal is not allowed.`,
      { field: 'path' },
    )
  }
  if (options.resolveSymlinks === true) {
    try {
      const real = await realpath(resolvedRequested)
      if (!isInsideRoot(real, root)) {
        throw new ConfigError(
          `Workspace-guard: realpath of "${requested}" (${real}) escapes workspaceRoot "${root}". Symlink traversal is not allowed.`,
          { field: 'path' },
        )
      }
      return real
    } catch (err) {
      // `realpath` throws ENOENT for non-existent files;
      // re-throw our own errors but pass the syscall
      // error through so the caller can surface a
      // actionable hint.
      if (err instanceof ConfigError) throw err
      // Soft-fail: the boundary check above already
      // passed; the file may not exist yet (write /
      // patch create). Return the string-resolved path.
      return resolvedRequested
    }
  }
  return resolvedRequested
}

/**
 * Pure string-only boundary check. Returns true when
 * `candidate` is `root` or a strict descendant of
 * `root`. The trailing `path.sep` boundary prevents
 * `/foo/bar2` from matching `/foo/bar`.
 *
 * Exported for tests and for callers that want to
 * perform the check without the resolve + realpath
 * machinery (e.g. when the input is already a
 * canonical absolute path).
 */
export const isInsideRoot = (candidate: string, root: string): boolean => {
  if (candidate === root) return true
  const prefix = root + path.sep
  return candidate.startsWith(prefix)
}
