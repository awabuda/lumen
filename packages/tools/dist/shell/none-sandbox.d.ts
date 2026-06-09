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
import type { ShellSandbox, ShellSandboxConfig, ShellSandboxOutcome, ShellSandboxRequest } from './sandbox.js';
export declare class NoneSandbox implements ShellSandbox {
    constructor(_config: ShellSandboxConfig);
    run(_request: ShellSandboxRequest): Promise<ShellSandboxOutcome>;
}
//# sourceMappingURL=none-sandbox.d.ts.map