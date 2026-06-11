/**
 * `lumen doctor` — diagnose the local Lumen install.
 *
 * Checks:
 *   - Config loads successfully
 *   - Default provider has an API key
 *   - Filesystem tools are registered
 *   - ripgrep is available (for the search tool's fast path)
 *   - Shell tools register and the default sandbox can spawn a
 *     real command (best-effort — a missing `sh`/`bash` is a
 *     warning, not a failure)
 *   - Git tool registers (git CLI is required for any of the
 *     `git` operations to work; we warn instead of fail to
 *     support `--no-git` deployments)
 *   - Skill registry can discover from the default skill root
 *     without writing to disk
 *   - MCP server discovery: lists configured servers, attempts
 *     to connect to each enabled one, and reports a per-server
 *     connect round-trip (skips the round-trip on config load
 *     failure so the user still sees the rest of the report)
 *
 * Prints a series of `[OK]` / `[WARN]` / `[FAIL]` lines. Exits 0 if
 * everything critical passes, 1 otherwise.
 */
export interface DoctorOptions {
    /**
     * Print extra detail for each check (e.g. raw environment
     * values, full MCP tool names, the resolved `defaultModel`).
     * Defaults to `false`.
     */
    readonly verbose?: boolean;
}
export declare const doctorCommand: (opts?: DoctorOptions) => Promise<number>;
//# sourceMappingURL=doctor.d.ts.map