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

export const doctorCommand = async (): Promise<number> => {
  let failed = 0
  const ok = (msg: string): void => {
    process.stdout.write(`  [OK]   ${msg}\n`)
  }
  const warn = (msg: string): void => {
    process.stdout.write(`  [WARN] ${msg}\n`)
  }
  const fail = (msg: string): void => {
    process.stdout.write(`  [FAIL] ${msg}\n`)
    failed += 1
  }

  process.stdout.write('Lumen doctor\n\n')

  // 1. Config
  try {
    const { loadCliConfig } = await import('../composition.js')
    const cfg = await loadCliConfig()
    ok(`Config loaded (agent.maxIterations=${cfg.agent.maxIterations})`)
  } catch (err) {
    fail(`Config failed to load: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 2. API key
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LUMEN_API_KEY
  if (apiKey) {
    ok('API key present (OPENAI_API_KEY or LUMEN_API_KEY)')
  } else {
    fail('No API key in OPENAI_API_KEY or LUMEN_API_KEY')
  }

  // 3. Filesystem tools
  try {
    const { createFilesystemTools } = await import('@lumen/tools')
    const tools = createFilesystemTools()
    ok(`Filesystem tools registered: ${tools.map((t) => t.name).join(', ')}`)
  } catch (err) {
    fail(`Failed to load filesystem tools: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Shell tools + default sandbox round-trip
  try {
    const { createShellTools, defaultShellSandboxConfig, resolveSandbox } = await import(
      '@lumen/tools'
    )
    const tools = createShellTools()
    ok(`Shell tools registered: ${tools.map((t) => t.name).join(', ')}`)

    // Round-trip a real command through the default sandbox.
    // We use a 2-second budget and `echo` so the check is fast
    // and side-effect-free. A failure here is a `[FAIL]` because
    // the user has `terminal` advertised but cannot use it.
    const config = defaultShellSandboxConfig({ timeoutMs: 2_000, maxOutputBytes: 1024 })
    const sandbox = resolveSandbox(config)
    const outcome = await sandbox.run({
      command: ['echo', 'lumen-doctor'],
      cwd: process.cwd(),
      env: {},
      timeoutMs: 2_000,
      signal: AbortSignal.timeout(2_000),
    })
    if (outcome.kind === 'ok' && outcome.result.exitCode === 0) {
      ok(`Shell sandbox round-trip OK (echo returned "${outcome.result.stdout.trim()}")`)
    } else if (outcome.kind === 'refused') {
      warn(`Shell sandbox refuses commands: ${outcome.reason} (${outcome.message})`)
    } else {
      fail(
        `Shell sandbox round-trip failed: exit=${outcome.kind === 'ok' ? outcome.result.exitCode : 'n/a'}`,
      )
    }
  } catch (err) {
    fail(`Failed to load shell tools: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 5. Git tools + git CLI availability
  try {
    const { createGitTools } = await import('@lumen/tools')
    const tools = createGitTools()
    ok(`Git tools registered: ${tools.map((t) => t.name).join(', ')}`)

    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['--version'], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    ok('git CLI on PATH (git tool ops will work)')
  } catch {
    warn('git CLI not on PATH; the git tool will fail every invocation')
  }

  // 6. ripgrep (best-effort)
  try {
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile('rg', ['--version'], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    ok('ripgrep available (search_files fast path enabled)')
  } catch {
    warn('ripgrep not on PATH (search_files will fall back to pure-Node implementation)')
  }

  process.stdout.write(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}\n`)
  return failed === 0 ? 0 : 1
}
