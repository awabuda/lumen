/**
 * `lumen doctor` — diagnose the local Lumen install.
 *
 * Checks:
 *   - Config loads successfully
 *   - Default provider has an API key
 *   - Filesystem tools are registered
 *   - ripgrep is available (for the search tool's fast path)
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

  // 4. ripgrep (best-effort)
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
