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
 *
 * Prints a series of `[OK]` / `[WARN]` / `[FAIL]` lines. Exits 0 if
 * everything critical passes, 1 otherwise.
 */
export declare const doctorCommand: () => Promise<number>;
//# sourceMappingURL=doctor.d.ts.map