/**
 * `lumen plan` — list / approve / reject plans persisted in the
 * default PlanStore JSON file.
 *
 * The in-memory `PlanStore` lives in `@lumen/core`. It is process-
 * scoped, so the CLI persists it to `~/.lumen/plans.json` between
 * `lumen run` and `lumen plan ...` invocations.
 *
 * Sub-commands:
 *   - `list` (default): print every plan in the JSON file, ordered
 *     by `createdAt` desc, with status (pending / approved /
 *     rejected).
 *   - `approve <id> [--notes <text>]`: mark the plan as approved.
 *   - `reject <id> [--notes <text>]`: mark the plan as rejected.
 *
 * Why a JSON file (and not the SQLite memory store):
 *   - `PlanStore` is part of the core tier (per `tier isolation`).
 *     It cannot import `@lumen/memory` (SqliteStore). A plain JSON
 *     file in `~/.lumen/` keeps the persistence layer zero-dep.
 *   - Plans are small (typically < 1 KB) and the read/write rate is
 *     operator-driven (one `lumen plan` per session, not per
 *     tool call). JSON roundtrip cost is negligible.
 *
 * Why we hydrate the entire file on every call:
 *   - Plans are append-mostly; full rewrite on mutation keeps the
 *     code branch-light and matches what `lumen run` does on exit
 *     (the agent loop has its own PlanStore instance and saves on
 *     plan creation; we do **not** mutate that store from this
 *     command — we hydrate a fresh PlanStore from disk so the
 *     `lumen run` instance is never the one that sees the edit).
 *   - This is operator UI, not hot path.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { PlanStore } from '@lumen/core'

const DEFAULT_PLANS_PATH = (): string => {
  const override = process.env.LUMEN_PLANS_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'plans.json')
}

const loadStore = async (file: string): Promise<PlanStore> => {
  const store = new PlanStore()
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      store.hydrate(parsed as Parameters<PlanStore['hydrate']>[0])
    }
  } catch (err) {
    // ENOENT on first run is normal; anything else surfaces.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err
    }
  }
  return store
}

const saveStore = async (file: string, store: PlanStore): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const json = store.toJSON()
  await fs.writeFile(file, JSON.stringify(json, null, 2), 'utf8')
}

const formatStatus = (plan: { approvedAt?: number; rejectedAt?: number }): string => {
  if (plan.approvedAt) return 'approved'
  if (plan.rejectedAt) return 'rejected'
  return 'pending'
}

export interface PlanListOptions {
  readonly file?: string
  /**
   * P37.c — output format. 'human' (default) is the
   * pre-P37.c one-line-per-plan text layout; 'json'
   * emits the PlanStore snapshot as JSON for CI.
   */
  readonly format?: 'human' | 'json'
}

export const planListCommand = async (opts: PlanListOptions = {}): Promise<number> => {
  const file = opts.file ?? DEFAULT_PLANS_PATH()
  const store = await loadStore(file)
  const plans = [...store.all].sort((a, b) => b.createdAt - a.createdAt)
  if (opts.format === 'json') {
    const rows = plans.map((plan) => ({
      id: plan.id,
      status: formatStatus(plan),
      goal: plan.goal,
      steps: plan.steps.length,
      createdAt: plan.createdAt,
      ...(plan.approvedAt !== undefined ? { approvedAt: plan.approvedAt } : {}),
      ...(plan.rejectedAt !== undefined ? { rejectedAt: plan.rejectedAt } : {}),
    }))
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return 0
  }
  if (plans.length === 0) {
    process.stdout.write(`(no plans in ${file})\n`)
    return 0
  }
  process.stdout.write(`Plans (${plans.length}) in ${file}:\n`)
  for (const plan of plans) {
    const status = formatStatus(plan)
    const stepCount = plan.steps.length
    process.stdout.write(
      `  - ${plan.id}  [${status}]  goal=${JSON.stringify(plan.goal)}  steps=${stepCount}  createdAt=${plan.createdAt}\n`,
    )
  }
  return 0
}

export interface PlanApproveOptions {
  readonly id: string
  readonly notes?: string
  readonly file?: string
  /**
   * P41.a — output format. 'human' (default) is
   * the pre-P41.a `approved <id>` text; 'json' emits
   * the post-approval Plan shape (CI-friendly).
   * Brings `approve` to parity with `list --format
   * json` (P37.c) and `show --format json` (P39.a).
   */
  readonly format?: 'human' | 'json'
  /**
   * P46.b — when true, do NOT actually apply the
   * approval. Instead, report what WOULD change
   * (the new status + the notes that would be
   * recorded) without writing the file. Useful in
   * CI to gate an approval on a pre-condition
   * (e.g. "only approve if the goal matches X").
   */
  readonly dryRun?: boolean
}

export const planApproveCommand = async (opts: PlanApproveOptions): Promise<number> => {
  const file = opts.file ?? DEFAULT_PLANS_PATH()
  const store = await loadStore(file)
  const updated = store.approve(opts.id, opts.notes)
  if (!updated) {
    process.stderr.write(`lumen plan approve: no plan with id "${opts.id}"\n`)
    return 1
  }
  if (opts.dryRun === true) {
    // P46.b — dry-run path: report the post-approval
    // shape WITHOUT calling saveStore. The human
    // path emits a `would approve ...` summary; the
    // JSON path emits the same shape the apply
    // path would.
    if (opts.format === 'json') {
      process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`)
      return 0
    }
    process.stdout.write(`would approve ${updated.id}\n`)
    return 0
  }
  await saveStore(file, store)
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`approved ${updated.id}\n`)
  return 0
}

export interface PlanShowOptions {
  readonly id?: string
  readonly file?: string
  /**
   * P39.a — output format. 'human' (default) is the
   * pre-P39.a one-block-per-plan text layout; 'json'
   * emits the full Plan shape (CI-friendly). Brings
   * `show` to parity with `list --format json` (P37.c).
   */
  readonly format?: 'human' | 'json'
  /**
   * P46.a — when true, omit the `notes` field from
   * both the human and JSON output. Useful for
   * CI consumers that pipe the output to a system
   * which does not need the operator's review
   * comments. Default `false` (pre-P46.a behaviour
   * preserves the notes — operators are still
   * expected to read the review).
   */
  readonly noNotes?: boolean
}

export interface PlanRejectOptions {
  readonly id: string
  readonly notes?: string
  readonly file?: string
  /**
   * P41.b — output format. 'human' (default) is
   * the pre-P41.b `rejected <id>` text; 'json' emits
   * the post-rejection Plan shape (CI-friendly).
   */
  readonly format?: 'human' | 'json'
}

export const planShowCommand = async (opts: PlanShowOptions = {}): Promise<number> => {
  const file = opts.file ?? DEFAULT_PLANS_PATH()
  const store = await loadStore(file)
  const plan = store.all.find((p) => p.id === opts.id)
  if (plan === undefined) {
    process.stderr.write(`lumen plan show: no plan with id "${opts.id}"\n`)
    return 1
  }
  if (opts.format === 'json') {
    // P46.a — when noNotes is set, omit the `notes`
    // field from the JSON output. The pre-P46.a
    // shape preserved the notes unconditionally.
    const payload: Record<string, unknown> =
      opts.noNotes === true ? { ...plan, notes: undefined } : { ...plan }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`Plan ${plan.id}\n`)
  process.stdout.write(`  status:  ${formatStatus(plan)}\n`)
  if (!(opts.noNotes === true)) {
    process.stdout.write(`  notes:   ${plan.notes ?? '(none)'}\n`)
  }
  process.stdout.write(`  goal:    ${JSON.stringify(plan.goal)}\n`)
  process.stdout.write(`  steps:   ${plan.steps.length}\n`)
  process.stdout.write(`  createdAt: ${plan.createdAt}\n`)
  if (plan.approvedAt !== undefined) process.stdout.write(`  approvedAt: ${plan.approvedAt}\n`)
  if (plan.rejectedAt !== undefined) process.stdout.write(`  rejectedAt: ${plan.rejectedAt}\n`)
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]
    if (step === undefined) continue
    process.stdout.write(`    [${i + 1}/${plan.steps.length}]  ${JSON.stringify(step)}\n`)
  }
  return 0
}

export const planRejectCommand = async (opts: PlanRejectOptions): Promise<number> => {
  const file = opts.file ?? DEFAULT_PLANS_PATH()
  const store = await loadStore(file)
  const updated = store.reject(opts.id, opts.notes)
  if (!updated) {
    process.stderr.write(`lumen plan reject: no plan with id "${opts.id}"\n`)
    return 1
  }
  await saveStore(file, store)
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`rejected ${updated.id}\n`)
  return 0
}
