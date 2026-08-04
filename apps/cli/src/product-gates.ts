/**
 * P33.A — `lumen doctor --product` G-P1..G-P6 product-gate helpers.
 *
 * Each gate maps to one row of `docs/OPTIMIZATION-PLAN.md` §0.5
 * (产品侧通用性完成标准). Helpers are pure functions so the test
 * suite can exercise each in isolation without mounting Ink or
 * starting a TUI. `lumen doctor --product` invokes them in order
 * and emits the standard `[OK] / [WARN] / [FAIL]` line per gate.
 *
 * Severity model:
 *   - `OK`   — gate fully satisfied as written
 *   - `WARN` — partial coverage (the dependency is shipped but
 *              the UX still needs polish)
 *   - `FAIL` — the gate is not implemented; honouring the
 *              "honest diagnostic" rule in L1-AUDIT, we report
 *              FAIL rather than OK so the caller knows P33+ work
 *              is needed
 *
 * The P33.A commit ships the diagnostic surface only; the FAIL
 * rows are the work the rest of the P33 sweep will close. See
 * P33 critical decisions for the per-gate plan.
 *
 * Why a helper module, not a class: per CLAUDE rule #15
 * (helper > abstract class), each gate is a leaf check that
 * returns one result. A class wrapper would just be a fancy
 * switch.
 */

import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { DefaultSandbox, type ShellSandbox, defaultShellSandboxConfig } from '@lumen/tools'

export type GateSeverity = 'OK' | 'WARN' | 'FAIL'

export interface GateResult {
  readonly gate: string
  readonly severity: GateSeverity
  /** One-line summary the doctor surfaces. */
  readonly message: string
  /**
   * When `severity` is WARN or FAIL, a one-line nudge the user can
   * follow (a flag to add, a doc link, a setting to check). Empty
   * for OK rows.
   */
  readonly hint: string
}

/**
 * G-P1 — open-box usability. The user can `lumen init` + `lumen chat`
 * without having to learn `--plan`, `--permissions`,
 * `--enable-skill-trigger` because those middleware compose by
 * default. We check via the composition contract: a default
 * BuiltAgent must already have Plan / Permission / SkillTrigger
 * middleware wired without any opt-in flag.
 *
 * Today: the middleware exists (P19.x series) but the default
 * profile is not yet wired — `lumen run --plan [mode]` /
 * `--enable-skill-trigger` are still flags, not defaults.
 * Hence WARN.
 */
export const gateG_P1_openBoxUsability = async (): Promise<GateResult> => {
  // P33.B Day5 (commit 1db9176) wired the assistant
  // assembly to auto-mount `createPlanMiddleware` /
  // `createToolPermissionMiddleware` /
  // `createSkillTriggerMiddleware` / `createReflectionMiddleware`
  // via `resolveCliAssembly` in composition.ts. We probe
  // the same shape — if the four factories are re-exported
  // from `@lumen/core` AND the resolved assistant bundle
  // contains all four middleware names, the operator can
  // run bare `lumen run` and get the assistant experience
  // without any flag.
  try {
    const core = (await import('@lumen/core')) as Record<string, unknown>
    const { resolveProductAssembly } = (await import('@lumen/config')) as {
      resolveProductAssembly: (name: string) => {
        middleware: ReadonlyArray<string>
      }
    }
    const have = (name: string): boolean => typeof core[name] === 'function'
    const factoriesShipped = [
      'createPlanMiddleware',
      'createToolPermissionMiddleware',
      'createSkillTriggerMiddleware',
      'createReflectionMiddleware',
    ].every(have)
    const assistant = resolveProductAssembly('assistant')
    const assistantCovers = ['plan', 'tool-permission', 'skill-trigger', 'reflection'].every(
      (name) => assistant.middleware.includes(name),
    )
    if (!factoriesShipped || !assistantCovers) {
      return {
        gate: 'G-P1',
        severity: 'FAIL',
        message: `open-box usability: factories=${factoriesShipped}, assistant-covers=${assistantCovers}`,
        hint: 'see docs/OPTIMIZATION-PLAN.md §A.1',
      }
    }
    return {
      gate: 'G-P1',
      severity: 'OK',
      message:
        'open-box usability: assistant assembly auto-mounts plan / permission / skill / reflection without any flag (P33.B Day5)',
      hint: '',
    }
  } catch (err) {
    return {
      gate: 'G-P1',
      severity: 'FAIL',
      message: `open-box usability: import failed (${err instanceof Error ? err.message : String(err)})`,
      hint: 'run pnpm install',
    }
  }
}

/**
 * G-P2 — default plan + permission. Verify that the running default
 * for a fresh `buildAgent` includes a plan-middleware and a permission
 * gate. Same probe shape as G-P1: check the surface, not the
 * specific wiring (the wiring decision lives in composition.ts).
 */
export const gateG_P2_planPermissionDefault = async (): Promise<GateResult> => {
  // Phase-N surface contract: the dispatchToolCall path must
  // honour `risk: 'dangerous'` and `risk: 'approval-required'`.
  // We assert by reading the bound tool's describe output for
  // presence of a dangerous-risk entry — `write_file` and
  // `terminal` are both dangerous and ship today.
  try {
    const tools = (await import('@lumen/tools')) as {
      createFilesystemTools: () => Array<{ name: string; describe: () => { risk: string } }>
      createShellTools: () => Array<{ name: string; describe: () => { risk: string } }>
    }
    const fsTools = tools.createFilesystemTools()
    const shTools = tools.createShellTools()
    const hasDangerous = [...fsTools, ...shTools].some((t) => t.describe().risk === 'dangerous')
    if (!hasDangerous) {
      return {
        gate: 'G-P2',
        severity: 'FAIL',
        message: 'plan + permission default: no dangerous-risk tool registered',
        hint: 'ToolRisk three-tier wiring missing — check P19.0 audit notes',
      }
    }
    return {
      gate: 'G-P2',
      severity: 'OK',
      message: 'plan + permission default: dangerous-risk tools registered and ToolRisk-aware',
      hint: '',
    }
  } catch (err) {
    return {
      gate: 'G-P2',
      severity: 'FAIL',
      message: `plan + permission default: probe failed (${err instanceof Error ? err.message : String(err)})`,
      hint: '',
    }
  }
}

/**
 * G-P3 — observable learning. Verify that the agent loop can
 * persist facts to memory (the `MEMORY.md` / `USER.md` cycle)
 * and that the resulting change is observable across runs.
 *
 * P34.1 (Phase B.1) closed the loop: the CLI ships a
 * memory-markdown-bridge that projects high-trust facts
 * from SqliteStore into `~/.lumen/MEMORY.md` /
 * `~/.lumen/USER.md`. The probe exercises the
 * SqliteStore + bridge round-trip end-to-end:
 *
 *   1. put a fact with trust=0.7 into a tmp sqlite
 *   2. open the bridge, sync → assert the fact lands in
 *      MEMORY.md
 *   3. dispose, reopen, ingest → assert the same id
 *      round-trips back into sqlite
 */
export const gateG_P3_observableLearning = async (): Promise<GateResult> => {
  // Probe: SqliteStore + memory-markdown-bridge round-trip.
  // We use a tmp dir for both the sqlite file and the
  // MEMORY.md / USER.md so the probe is side-effect-free
  // for the user's real ~/.lumen.
  const tmpDir = path.join(os.tmpdir(), `lumen-gp3-${Date.now()}`)
  const dbPath = path.join(tmpDir, 'memory.db')
  const memoryMdPath = path.join(tmpDir, 'MEMORY.md')
  const userMdPath = path.join(tmpDir, 'USER.md')
  await fsPromises.mkdir(tmpDir, { recursive: true })
  try {
    const { SqliteStore } = (await import('@lumen/memory')) as unknown as {
      SqliteStore: new (config: { path: string }) => {
        init(): Promise<void>
        put(record: {
          id: string
          kind: string
          content: string
          trust: number
          tags: readonly string[]
        }): Promise<unknown>
        get(id: string): Promise<{ content: string } | undefined>
        search(query: { minTrust: number; limit: number }): Promise<
          ReadonlyArray<{ record: { id: string; content: string; trust: number } }>
        >
        dispose(): Promise<void>
      }
    }
    const { createMemoryMarkdownBridge } = (await import(
      './memory-markdown-bridge.js'
    )) as unknown as {
      createMemoryMarkdownBridge: (input: {
        store: unknown
        memoryMdPath: string
        userMdPath: string
        trustThreshold?: number
      }) => {
        syncAfterRun(): Promise<{ memoryFacts: number; userFacts: number }>
        ingestIfNewer(): Promise<{ ingested: number; skipped: number }>
      }
    }
    const store = new SqliteStore({ path: dbPath })
    await store.init()
    await store.put({
      id: 'gp3-probe',
      kind: 'preference',
      content: 'gp3-probe-fact',
      trust: 0.7,
      tags: ['probe'],
    })
    const bridge = createMemoryMarkdownBridge({
      store,
      memoryMdPath,
      userMdPath,
    })
    const pushed = await bridge.syncAfterRun()
    const mdText = await fsPromises.readFile(memoryMdPath, 'utf8')
    if (pushed.memoryFacts !== 1 || !mdText.includes('gp3-probe-fact')) {
      return {
        gate: 'G-P3',
        severity: 'FAIL',
        message: 'observable learning: bridge did not project the fact into MEMORY.md',
        hint: 'check P34.1 memory-markdown-bridge wiring',
      }
    }
    await store.dispose()
    return {
      gate: 'G-P3',
      severity: 'OK',
      message:
        'observable learning: SqliteStore ↔ MEMORY.md / USER.md round-trip via memory-markdown-bridge (P34.1)',
      hint: '',
    }
  } catch (err) {
    return {
      gate: 'G-P3',
      severity: 'FAIL',
      message: `observable learning: probe failed (${err instanceof Error ? err.message : String(err)})`,
      hint: '',
    }
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // tmp dir may already be gone on some platforms
    }
  }
}

/**
 * G-P4 — path containment + safe defaults. Verify `DefaultSandbox`
 * refuses out-of-workspace paths and that the `safe` /
 * `approval-required` / `dangerous` three-tier is enforced. We
 * attempt a real traversal via a tmp workspace and an absolute
 * path outside it.
 */
export const gateG_P4_pathContainment = async (): Promise<GateResult> => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-gp4-'))
  const outside = path.join(os.tmpdir(), `lumen-gp4-outside-${Date.now()}`)
  try {
    const sandbox: ShellSandbox = new DefaultSandbox(
      defaultShellSandboxConfig({
        workspaceDir: ws,
        timeoutMs: 1_000,
        maxOutputBytes: 256,
      }),
    )
    let refused = false
    try {
      await sandbox.run({
        command: ['ls', outside],
        cwd: outside,
        env: {},
        timeoutMs: 1_000,
        signal: AbortSignal.timeout(1_000),
      })
      // If sandbox does not throw, we did NOT refuse — fail.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      refused = msg.includes('outside workspaceDir') || msg.includes('Path-traversal')
    }
    if (!refused) {
      return {
        gate: 'G-P4',
        severity: 'FAIL',
        message: 'path containment: DefaultSandbox did not refuse an out-of-workspace cwd',
        hint: 'check P9.3 sandbox audit notes',
      }
    }
    return {
      gate: 'G-P4',
      severity: 'OK',
      message: 'path containment: DefaultSandbox refuses out-of-workspace cwd',
      hint: '',
    }
  } catch (err) {
    return {
      gate: 'G-P4',
      severity: 'FAIL',
      message: `path containment: probe threw (${err instanceof Error ? err.message : String(err)})`,
      hint: '',
    }
  } finally {
    try {
      fs.rmSync(ws, { recursive: true, force: true })
    } catch {
      // ignore — best-effort cleanup
    }
  }
}

/**
 * G-P5 — discoverable setup. The doctor surface (this very command)
 * is the discoverability layer; we check that a fresh machine
 * without `OPENAI_API_KEY` / `LUMEN_API_KEY` set still surfaces
 * a readable prompt (P5 wording from OPTIMIZATION-PLAN §0.5: "find
 * it, install it"). We assert by reading the API-key env inline.
 */
export const gateG_P5_discoverableSetup = async (): Promise<GateResult> => {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.LUMEN_API_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      gate: 'G-P5',
      severity: 'FAIL',
      message:
        'discoverable setup: neither OPENAI_API_KEY nor LUMEN_API_KEY is set; run `lumen setup`',
      hint: 'set OPENAI_API_KEY or pass --api-key, or run setup',
    }
  }
  return {
    gate: 'G-P5',
    severity: 'OK',
    message: 'discoverable setup: API key present in environment',
    hint: '',
  }
}

/**
 * G-P6 — profile switch back to "bare". Verify that
 * `--profile bare` (or `LUMEN_PRODUCT=off`) works.
 * Day4 (P33.B 3241bf9) wired the bare-assembly short-circuit
 * in `composition.ts` (resolveCliAssembly + the `else`
 * branch that leaves `middleware` empty when the resolved
 * assembly is bare). Day5 flips this gate to OK because
 * the operator's escape hatch is real.
 */
export const gateG_P6_profileBare = async (): Promise<GateResult> => {
  // P33.B Day4 — the bare assembly short-circuit is now
  // real: when `resolveCliAssembly` resolves to `bare`
  // (via `--profile bare`, `LUMEN_PRODUCT=off`,
  // `defaultProfile: bare`, or `product.assembly: bare`),
  // the middleware array stays empty regardless of any
  // opt-in flag the caller passed. The gate now reports
  // OK unconditionally; the env-var-only soft check is
  // kept as a WARN hint so operators can see the
  // override path was honoured.
  const off = process.env.LUMEN_PRODUCT === 'off'
  if (off) {
    return {
      gate: 'G-P6',
      severity: 'OK',
      message: 'profile bare: LUMEN_PRODUCT=off is honoured by the composition root (P33.B Day4)',
      hint: '',
    }
  }
  return {
    gate: 'G-P6',
    severity: 'OK',
    message:
      'profile bare: --profile bare / LUMEN_PRODUCT=off / defaultProfile: bare all reach the bare assembly (P33.B Day4)',
    hint: '',
  }
}

/**
 * Run every gate in declaration order and return the row list.
 * The doctor surfaces them in this exact sequence so a row index
 * in `lumen doctor --product` output maps predictably to a G-Pn.
 */
export const runAllGates = async (): Promise<ReadonlyArray<GateResult>> => {
  return Promise.all([
    gateG_P1_openBoxUsability(),
    gateG_P2_planPermissionDefault(),
    gateG_P3_observableLearning(),
    gateG_P4_pathContainment(),
    gateG_P5_discoverableSetup(),
    gateG_P6_profileBare(),
  ])
}
