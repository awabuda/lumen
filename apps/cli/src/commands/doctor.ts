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

import { loadCliConfig } from '../composition.js'

export interface DoctorOptions {
  /**
   * Print extra detail for each check (e.g. raw environment
   * values, full MCP tool names, the resolved `defaultModel`).
   * Defaults to `false`.
   */
  readonly verbose?: boolean
  /**
   * P33.A — additionally run the G-P1..G-P6 product gates from
   * `docs/OPTIMIZATION-PLAN.md` §0.5. Each gate is its own row
   * in the doctor output, printed after the existing 10
   * infrastructure checks. Default `false`.
   */
  readonly product?: boolean
}

export const doctorCommand = async (opts: DoctorOptions = {}): Promise<number> => {
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
  if (opts.verbose) {
    process.stdout.write(`  cwd:      ${process.cwd()}\n`)
    process.stdout.write(`  node:     ${process.version}\n`)
    process.stdout.write(`  platform: ${process.platform} ${process.arch}\n\n`)
  }

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
    if (opts.verbose) {
      for (const t of tools) {
        const d = t.describe()
        process.stdout.write(`    ${d.name}  v${d.version}  risk=${d.risk}\n`)
      }
    }
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

  // 6. Memory store round-trip (in-memory SQLite).
  //    We do NOT touch the on-disk default (~/.lumen/memory.db)
  //    so `lumen doctor` stays side-effect-free for a fresh
  //    install. A failure here is `[FAIL]` because the agent
  //    loop will throw on its first `appendMessage` without a
  //    working memory backend.
  try {
    const { SqliteStore } = await import('@lumen/memory')
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    try {
      await store.createSession({ id: 'doctor-session', title: 'doctor probe' })
      await store.appendMessage({
        sessionId: 'doctor-session',
        role: 'user',
        content: 'ping',
      })
      const messages = await store.getSessionMessages('doctor-session')
      if (messages.length === 1 && messages[0]?.content === 'ping') {
        ok('Memory store round-trip OK (session + message persisted + read back)')
      } else {
        fail(`Memory round-trip returned unexpected messages: ${JSON.stringify(messages)}`)
      }
    } finally {
      await store.dispose()
    }
  } catch (err) {
    fail(`Memory store failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 7. Skills registry discovery (read-only).
  //    Missing ~/.lumen/skills is OK: discovery returns an empty list.
  try {
    const { FilesystemSkillSource, defaultSkillsPath, SkillRegistry } = await import(
      '@lumen/skills'
    )
    const source = new FilesystemSkillSource({ rootDir: defaultSkillsPath() })
    const skills = await source.discover({ cwd: process.cwd() })
    const registry = new SkillRegistry()
    registry.registerAll(skills)
    ok(`Skills registry OK (${registry.size} skill(s) discovered)`)
  } catch (err) {
    fail(`Skills registry failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 8. ripgrep (best-effort)
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

  // 9. MCP server discovery + connect round-trip.
  //    Read the config we already loaded above (or reload
  //    if step 1 failed) and try to connect to every
  //    enabled server. The round-trip is bounded by a
  //    3-second per-server timeout so `lumen doctor`
  //    stays fast even on misbehaving servers. Failures
  //    are `[WARN]` rather than `[FAIL]` — the user may
  //    intentionally have a server that's offline — but
  //    a discoverability bug (we can't even *list* the
  //    config) is a `[FAIL]`.
  try {
    const cfg = await loadCliConfig()
    const servers = cfg.mcp?.servers ?? []
    if (servers.length === 0) {
      ok('MCP: no servers configured (run with config.mcp.servers to enable)')
    } else {
      const { connectAllMcpServers, closeAllMcpServers } = await import('@lumen/mcp')
      const { ToolRegistry } = await import('@lumen/core')
      const registry = new ToolRegistry()
      const connected = await connectAllMcpServers(servers, registry, { timeoutMs: 3_000 })
      try {
        const toolCount = connected.reduce((acc, s) => acc + s.tools.length, 0)
        if (connected.length === servers.length) {
          ok(
            `MCP: ${connected.length}/${servers.length} server(s) connected, ${toolCount} tool(s) registered (${connected
              .map((s) => `${s.name}=${s.tools.length}`)
              .join(', ')})`,
          )
        } else {
          const failed = servers
            .filter((s) => !connected.find((c) => c.name === s.name))
            .map((s) => s.name)
          warn(
            `MCP: ${connected.length}/${servers.length} server(s) connected; failed: ${failed.join(', ')}`,
          )
        }
      } finally {
        await closeAllMcpServers(connected)
      }
    }
  } catch (err) {
    fail(`MCP discovery failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 10. better-sqlite3 ABI drift (P32.5).
  //     The prebuilt `.node` binary is tied to one Node ABI. When
  //     the developer upgrades Node and forgets `pnpm rebuild:native`,
  //     every Sqlite*Store constructor throws an opaque error. This
  //     check probes the binary directly so the failure path is
  //     explicit at the doctor surface, with a one-line remediation
  //     pointing at the rebuild script. A drift is `[FAIL]` — every
  //     lumen run/chat that touches persistence is broken.
  try {
    const { formatAbiDoctorMessage, probeBetterSqlite3Abi } = await import('../native-abi.js')
    const probe = probeBetterSqlite3Abi()
    if (probe.ok) {
      ok(formatAbiDoctorMessage(probe))
      if (opts.verbose && probe.binaryPath !== undefined) {
        process.stdout.write(`    binary:  ${probe.binaryPath}\n`)
      }
    } else {
      fail(formatAbiDoctorMessage(probe))
    }
  } catch (err) {
    fail(`better-sqlite3 ABI check crashed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 11. (opt-in) G-P1..G-P6 product gates (P33.A).
  //     Only runs when `--product` is passed. Each gate emits one
  //     `[OK]/[WARN]/[FAIL]` line so a CI gate can grep the
  //     output. Product-gate FAIL rows do NOT bump the doctor
  //     exit code (they are informational, mirroring the WARN
  //     path); only infrastructure FAIL rows do. Future P33+
  //     work will close G-P1 and G-P6; we WANT to print them
  //     as FAIL today so the remaining work is visible.
  if (opts.product === true) {
    process.stdout.write('\nProduct gates (--product):\n')
    let productFailed = 0
    try {
      const { runAllGates } = await import('../product-gates.js')
      const results = await runAllGates()
      for (const r of results) {
        const tag = `[${r.severity}]`
        const spaces = ' '.repeat(Math.max(0, 5 - r.severity.length))
        process.stdout.write(`  ${tag}${spaces}${r.message}\n`)
        if (r.severity === 'FAIL') {
          productFailed += 1
        }
        if (r.hint.length > 0) {
          process.stdout.write(`         hint: ${r.hint}\n`)
        }
      }
      if (productFailed === 0) {
        process.stdout.write('  All product gates pass.\n')
      } else {
        process.stdout.write(`  ${productFailed} product gate(s) still pending — see OPTIMIZATION-PLAN.md §0.5.\n`)
      }
    } catch (err) {
      fail(
        `product gate runner crashed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  process.stdout.write(`\n${failed === 0 ? 'All checks passed.' : `${failed} check(s) failed.`}\n`)
  return failed === 0 ? 0 : 1
}
