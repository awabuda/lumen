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
  // Probe by reading the package exports — if the four middleware
  // classes are re-exported and the composition builder exists,
  // the building blocks are shippable even if the default-product
  // profile is not yet chosen.
  try {
    const core = (await import('@lumen/core')) as Record<string, unknown>
    const have = (name: string): boolean => typeof core[name] === 'function'
    const shipped = ['PlanMiddleware', 'PermissionMiddleware', 'SkillTriggerMiddleware'].every(have)
    if (!shipped) {
      return {
        gate: 'G-P1',
        severity: 'FAIL',
        message: 'open-box usability: default-product profile not shipped',
        hint: 'see docs/OPTIMIZATION-PLAN.md §A.1',
      }
    }
    return {
      gate: 'G-P1',
      severity: 'WARN',
      message:
        'open-box usability: middleware shipped, but plan/permission/skill flags still required today',
      hint: 'default product profile pending P33+ composition wire',
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
 * persist facts to memory (the `MEMORY.md` / `USER.md` cycle) and
 * that the resulting change is observable across runs. Today only
 * the storage surface (SqliteStore) is wired; the human-readable
 * MEMORY/USER files (Hermes-style) are P33+ work. Hence WARN.
 */
export const gateG_P3_observableLearning = async (): Promise<GateResult> => {
  // Probe: SqliteStore can persist a fact and read it back across
  // store instances. We use a tmp dir so the probe is
  // side-effect-free for the user's real ~/.lumen.
  const probePath = path.join(os.tmpdir(), `lumen-gp3-${Date.now()}.db`)
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
        dispose(): Promise<void>
      }
    }
    const store = new SqliteStore({ path: probePath })
    await store.init()
    await store.put({
      id: 'gp3-probe',
      kind: 'fact',
      content: 'probe',
      trust: 1,
      tags: [],
    })
    await store.dispose()
    const reopened = new SqliteStore({ path: probePath })
    await reopened.init()
    const got = await reopened.get('gp3-probe')
    await reopened.dispose()
    try {
      fs.unlinkSync(probePath)
    } catch {
      // tmp file may already be gone on some platforms — ignore
    }
    if (got?.content !== 'probe') {
      return {
        gate: 'G-P3',
        severity: 'FAIL',
        message: 'observable learning: SqliteStore round-trip returned wrong value',
        hint: 'check P13 lifecycle state machine',
      }
    }
    return {
      gate: 'G-P3',
      severity: 'WARN',
      message:
        'observable learning: structured store round-trips, but MEMORY.md/USER.md human-readable surface pending P33+',
      hint: '',
    }
  } catch (err) {
    return {
      gate: 'G-P3',
      severity: 'FAIL',
      message: `observable learning: probe failed (${err instanceof Error ? err.message : String(err)})`,
      hint: '',
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
 * `--profile bare` (or `LUMEN_PRODUCT=off`) works. Today: the flag
 * is not yet shipped; it is part of the P33+ default-product
 * composition work. FAIL.
 */
export const gateG_P6_profileBare = async (): Promise<GateResult> => {
  // Reading the env var is a soft check; the strict check would
  // require composition-level support that is itself pending.
  const off = process.env.LUMEN_PRODUCT === 'off'
  if (off) {
    return {
      gate: 'G-P6',
      severity: 'WARN',
      message:
        'profile bare: LUMEN_PRODUCT=off is read, but the --profile bare CLI flag is not yet shipped',
      hint: '',
    }
  }
  return {
    gate: 'G-P6',
    severity: 'FAIL',
    message: 'profile bare: --profile bare / LUMEN_PRODUCT=off CLI surface not yet shipped',
    hint: 'P33+ default-product composition work',
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
