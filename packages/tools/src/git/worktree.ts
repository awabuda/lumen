/**
 * P25.2 \u2014 worktree isolation (bug.md #43).
 *
 * Wrap a sub-agent's lifetime with a `git worktree add` +
 * `git worktree remove` pair so the sub-agent's edits land
 * on an isolated branch, not on the operator's working
 * branch. The pre-P25.2 codebase had no equivalent: a
 * sub-agent that ran `terminal` or `git commit` mutated
 * the operator's checkout directly.
 *
 * Why a helper function (P19+ rule 15) and not a new
 * abstract class: the worktree lifecycle is just a
 * three-step recipe (add \u2192 run \u2192 remove). Wrapping
 * it in `BaseWorktree` would be overhead for zero
 * behavioural gain.
 */

import { execFile as _nodeExecFile } from 'node:child_process'
import { promisify } from 'node:util'

// Promisified so the helpers compose with `await`.
const execFile = promisify(_nodeExecFile) as (
  file: string,
  args: ReadonlyArray<string>,
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>

/** The worktree handle. Call `release()` to remove it. */
export interface Worktree {
  /** Absolute path of the worktree on disk. */
  readonly path: string
  /** Branch name (e.g. `lumen-sub/explore-1`). */
  readonly branch: string
  /** Id of the owning sub-agent. */
  readonly subAgentId: string
  /** `git worktree remove --force <path>`. Safe to call twice. */
  release: () => Promise<void>
}

/**
 * `git worktree add -b <branch> <path>` over the given
 * repository root. The path is created under
 * `${os.tmpdir()}/lumen-worktrees/<subAgentId>-<timestamp>` so
 * two parallel sub-agents never collide.
 *
 * The branch name is `lumen-sub/<subAgentId>`. Operators can
 * prune them later with `git worktree prune` once the
 * sub-agent is done.
 */
export const createWorktree = async (params: {
  readonly cwd: string
  readonly subAgentId: string
}): Promise<Worktree> => {
  const timestamp = Date.now()
  const branch = `lumen-sub/${params.subAgentId}`
  const path = `${params.cwd}/.lumen-worktrees/${params.subAgentId}-${timestamp}`
  await execFile('git', ['worktree', 'add', '-b', branch, path], { cwd: params.cwd })
  let released = false
  const release = async (): Promise<void> => {
    if (released) return
    released = true
    try {
      await execFile('git', ['worktree', 'remove', '--force', path], {
        cwd: params.cwd,
      })
    } catch {
      // Best-effort. Worktree cleanup must never throw.
    }
  }
  return { path, branch, subAgentId: params.subAgentId, release }
}

/**
 * Run a callback inside a worktree, then release it. If the
 * callback throws, the worktree is still released (best-effort).
 *
 * The callback's `cwd` is set to the worktree path; the
 * callback's `branch` lets the operator name the work in
 * commit messages if they want to.
 */
export const runInWorktree = async <T>(
  params: { readonly cwd: string; readonly subAgentId: string },
  fn: (ctx: { readonly cwd: string; readonly branch: string }) => Promise<T>,
): Promise<T> => {
  const wt = await createWorktree(params)
  try {
    return await fn({ cwd: wt.path, branch: wt.branch })
  } finally {
    await wt.release()
  }
}