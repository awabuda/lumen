/**
 * `NoneSandbox` — refuses every command with `policy-disabled`.
 *
 * Use this when the operator wants the agent shipped with the
 * `terminal` tool *available* (so its descriptor still appears
 * in the agent's tool list and the LLM can reason about it) but
 * every actual call refused at the sandbox level.
 *
 * Typical deployment: a production gateway where the agent must
 * not be able to execute shell commands regardless of what the
 * LLM says.
 *
 * The refusal is **deterministic and synchronous** — no
 * child process is spawned, no timer is set, no env is computed.
 * The cost of a refused call is a Promise microtask and an
 * object allocation.
 */
import type {
  ShellSandbox,
  ShellSandboxConfig,
  ShellSandboxOutcome,
  ShellSandboxRequest,
} from './sandbox.js'

export class NoneSandbox implements ShellSandbox {
  // Config is accepted to satisfy the contract; this sandbox
  // ignores it because it has no parameters at all.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: ShellSandboxConfig) {}

  public run(_request: ShellSandboxRequest): Promise<ShellSandboxOutcome> {
    return Promise.resolve({
      kind: 'refused' as const,
      reason: 'policy-disabled' as const,
      message:
        'Shell execution is disabled by policy. The "none" sandbox strategy is configured; ' +
        'change the strategy to "default" (or a registered alternative) to enable the terminal tool.',
    })
  }
}
