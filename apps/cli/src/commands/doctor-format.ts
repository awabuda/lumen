/**
 * P35 (Phase C.2 slice) — `lumen doctor --format json`.
 *
 * Pure helper that turns the existing doctor output
 * into a structured JSON array. Keeps the doctor
 * command's stdout writes for the human path
 * untouched; the JSON path replaces the walk-with-
 * side-effects loop with a single accumulator.
 *
 * Why a separate helper:
 *   - Reads cleaner (no `result.push` interleaved with
 *     `process.stdout.write`).
 *   - Unit-testable without monkey-patching stdout.
 *   - Reuses the same severity vocabulary as
 *     `runAllGates` (`'OK' | 'WARN' | 'FAIL'`) so CI
 *     pipelines can grep a single tag set.
 */

export type DoctorSeverity = 'OK' | 'WARN' | 'FAIL'

export interface DoctorRow {
  readonly severity: DoctorSeverity
  readonly section: string
  readonly message: string
  /** Optional remediation hint. Empty string when none. */
  readonly hint: string
}

/**
 * Emit one row per infrastructure check. The shape
 * mirrors the human format verbatim:
 *   `[OK]   Config loaded (agent.maxIterations=...)`
 * Why order matters: CI pipelines that diff against
 * the JSON output rely on a deterministic ordering.
 */
export const buildDoctorRows = async (
  options: {
    readonly product?: boolean
    readonly verbose?: boolean
    /**
     * P40.c — when true, skip the API key presence check
     * (treat it as a WARN row with the SKIP marker rather
     * than a FAIL). When undefined / false, the missing
     * key is a FAIL row (the pre-P37.d default).
     */
    readonly noApiKey?: boolean
    /**
     * P43.a — restrict the row set to a single top-level
     * section (e.g. `config`, `mcp`, `api-key`). When
     * undefined, all rows are emitted (the pre-P43.a
     * default). The shape of the returned array is
     * unchanged — only the count differs. CI can use
     * this to slice the doctor output without having to
     * pipe through `jq`.
     */
    readonly section?: string
  } = {},
): Promise<DoctorRow[]> => {
  const rows: DoctorRow[] = []
  const { loadCliConfig } = await import('../composition.js')
  // 1. Config
  try {
    const cfg = await loadCliConfig()
    rows.push({
      severity: 'OK',
      section: 'config',
      message: `Config loaded (agent.maxIterations=${cfg.agent.maxIterations})`,
      hint: '',
    })
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'config',
      message: `Config failed to load: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'check ~/.lumen/config.yaml + project config schema',
    })
  }
  // 2. API key (P37.d) — when noApiKey is true, the
  // missing-key row is reported as WARN (with the SKIP
  // marker in the message) instead of FAIL. The earlier
  // pre-P37.d behaviour is preserved when noApiKey is
  // unset.
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LUMEN_API_KEY
  if (apiKey) {
    rows.push({
      severity: 'OK',
      section: 'api-key',
      message: 'API key present (OPENAI_API_KEY or LUMEN_API_KEY)',
      hint: '',
    })
  } else if (options.noApiKey === true) {
    rows.push({
      severity: 'WARN',
      section: 'api-key',
      message: '[SKIP] API key check (--no-api-key)',
      hint: '',
    })
  } else {
    rows.push({
      severity: 'FAIL',
      section: 'api-key',
      message: 'No API key in OPENAI_API_KEY or LUMEN_API_KEY',
      hint: 'export OPENAI_API_KEY=...',
    })
  }
  // 3. Filesystem tools
  try {
    const { createFilesystemTools } = await import('@lumen/tools')
    const tools = createFilesystemTools()
    rows.push({
      severity: 'OK',
      section: 'filesystem-tools',
      message: `Filesystem tools registered: ${tools.map((t) => t.name).join(', ')}`,
      hint: '',
    })
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'filesystem-tools',
      message: `Failed to load filesystem tools: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'rebuild @lumen/tools (pnpm install)',
    })
  }
  // 4. Shell tools
  try {
    const { createShellTools, defaultShellSandboxConfig, resolveSandbox } = await import(
      '@lumen/tools'
    )
    const tools = createShellTools()
    rows.push({
      severity: 'OK',
      section: 'shell-tools',
      message: `Shell tools registered: ${tools.map((t) => t.name).join(', ')}`,
      hint: '',
    })
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
      rows.push({
        severity: 'OK',
        section: 'shell-sandbox',
        message: `Shell sandbox round-trip OK (echo returned "${outcome.result.stdout.trim()}")`,
        hint: '',
      })
    } else {
      rows.push({
        severity: 'FAIL',
        section: 'shell-sandbox',
        message: `Shell sandbox round-trip failed: ${outcome.kind}`,
        hint: 'check sandbox config + PATH',
      })
    }
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'shell-tools',
      message: `Failed to load shell tools: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'rebuild @lumen/tools',
    })
  }
  // 5. Git tools
  try {
    const { createGitTools } = await import('@lumen/tools')
    const tools = createGitTools()
    rows.push({
      severity: 'OK',
      section: 'git-tools',
      message: `Git tools registered: ${tools.map((t) => t.name).join(', ')}`,
      hint: '',
    })
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile('git', ['--version'], (err) => (err ? reject(err) : resolve()))
    })
    rows.push({
      severity: 'OK',
      section: 'git-cli',
      message: 'git CLI on PATH (git tool ops will work)',
      hint: '',
    })
  } catch {
    rows.push({
      severity: 'WARN',
      section: 'git-cli',
      message: 'git CLI not on PATH; the git tool will fail every invocation',
      hint: 'install git + add to PATH',
    })
  }
  // 6. Memory store (in-memory SQLite).
  try {
    const { SqliteStore } = await import('@lumen/memory')
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    try {
      await store.createSession({ id: 'doctor-session', title: 'doctor probe' })
      await store.appendMessage({ sessionId: 'doctor-session', role: 'user', content: 'ping' })
      const messages = await store.getSessionMessages('doctor-session')
      if (messages.length === 1 && messages[0]?.content === 'ping') {
        rows.push({
          severity: 'OK',
          section: 'memory-store',
          message: 'Memory store round-trip OK (session + message persisted + read back)',
          hint: '',
        })
      } else {
        rows.push({
          severity: 'FAIL',
          section: 'memory-store',
          message: `Memory round-trip returned unexpected messages: ${JSON.stringify(messages)}`,
          hint: 'check SqliteStore impl',
        })
      }
    } finally {
      await store.dispose()
    }
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'memory-store',
      message: `Memory store failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'check better-sqlite3 ABI',
    })
  }
  // 7. Skills registry
  try {
    const { FilesystemSkillSource, defaultSkillsPath, SkillRegistry } = await import(
      '@lumen/skills'
    )
    const source = new FilesystemSkillSource({ rootDir: defaultSkillsPath() })
    const skills = await source.discover({ cwd: process.cwd() })
    const registry = new SkillRegistry()
    registry.registerAll(skills)
    rows.push({
      severity: 'OK',
      section: 'skills-registry',
      message: `Skills registry OK (${registry.size} skill(s) discovered)`,
      hint: '',
    })
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'skills-registry',
      message: `Skills registry failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'check ~/.lumen/skills directory',
    })
  }
  // 8. ripgrep
  try {
    const { execFile } = await import('node:child_process')
    await new Promise<void>((resolve, reject) => {
      execFile('rg', ['--version'], (err) => (err ? reject(err) : resolve()))
    })
    rows.push({
      severity: 'OK',
      section: 'ripgrep',
      message: 'ripgrep available (search_files fast path enabled)',
      hint: '',
    })
  } catch {
    rows.push({
      severity: 'WARN',
      section: 'ripgrep',
      message: 'ripgrep not on PATH (search_files will fall back to pure-Node implementation)',
      hint: 'install ripgrep for the fast path',
    })
  }
  // 9. MCP
  try {
    const cfg = await loadCliConfig()
    const servers = cfg.mcp?.servers ?? []
    if (servers.length === 0) {
      rows.push({
        severity: 'OK',
        section: 'mcp',
        message: 'MCP: no servers configured (run with config.mcp.servers to enable)',
        hint: '',
      })
    } else {
      const { connectAllMcpServers, closeAllMcpServers } = await import('@lumen/mcp')
      const { ToolRegistry } = await import('@lumen/core')
      const registry = new ToolRegistry()
      const connected = await connectAllMcpServers(servers, registry, { timeoutMs: 3_000 })
      try {
        const toolCount = connected.reduce((acc, s) => acc + s.tools.length, 0)
        if (connected.length === servers.length) {
          rows.push({
            severity: 'OK',
            section: 'mcp',
            message: `MCP: ${connected.length}/${servers.length} server(s) connected, ${toolCount} tool(s) registered`,
            hint: '',
          })
        } else {
          rows.push({
            severity: 'WARN',
            section: 'mcp',
            message: `MCP: ${connected.length}/${servers.length} server(s) connected`,
            hint: 'check failed server config',
          })
        }
      } finally {
        await closeAllMcpServers(connected)
      }
    }
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'mcp',
      message: `MCP discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'check config.mcp.servers',
    })
  }
  // 10. better-sqlite3 ABI
  try {
    const { formatAbiDoctorMessage, probeBetterSqlite3Abi } = await import('../native-abi.js')
    const probe = probeBetterSqlite3Abi()
    const msg = formatAbiDoctorMessage(probe)
    if (probe.ok) {
      rows.push({
        severity: 'OK',
        section: 'sqlite-abi',
        message: msg,
        hint: '',
      })
    } else {
      rows.push({
        severity: 'FAIL',
        section: 'sqlite-abi',
        message: msg,
        hint: 'pnpm rebuild:native',
      })
    }
  } catch (err) {
    rows.push({
      severity: 'FAIL',
      section: 'sqlite-abi',
      message: `better-sqlite3 ABI check crashed: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'pnpm rebuild:native',
    })
  }
  // 11. product gates (P33.A)
  if (options.product === true) {
    try {
      const { runAllGates } = await import('../product-gates.js')
      const results = await runAllGates()
      for (const r of results) {
        const [section, ...rest] = r.message.split(':')
        rows.push({
          severity: r.severity,
          section: `gate.${section ?? r.gate}`.trim(),
          message: rest.length > 0 ? rest.join(':').trim() : r.message,
          hint: r.hint,
        })
      }
    } catch (err) {
      rows.push({
        severity: 'FAIL',
        section: 'product-gates',
        message: `product gate runner crashed: ${err instanceof Error ? err.message : String(err)}`,
        hint: 'check product-gates.ts',
      })
    }
  }
  // `verbose` is already accounted for by the human
  // path (which prints extra metadata). The JSON
  // path is fully exhaustive without a verbose
  // gate, so we leave the flag as a no-op marker.
  void options.verbose
  // P43.a — when `section` is set, restrict the
  // returned array to that single section. The
  // human path is unchanged (the human path
  // always prints every row).
  if (options.section === undefined) {
    return rows
  }
  return rows.filter((r) => r.section === options.section)
}
