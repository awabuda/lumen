/** Tests for `lumen plan` command handlers. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanSchema, PlanStore } from '@lumen/core'
import {
  planApproveCommand,
  planListCommand,
  planRejectCommand,
} from '../src/commands/plan.js'

let tmpDir: string
let plansPath: string
let stdout = ''
let stderr = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-cli-plan-test-'))
  plansPath = path.join(tmpDir, 'plans.json')
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

/**
 * Pre-seed a plans.json file using the same `PlanStore` class
 * the agent uses, then point the CLI at the same file.
 */
const seed = async (ids: ReadonlyArray<string>): Promise<void> => {
  const store = new PlanStore()
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i] ?? `plan-${i}`
    store.save(
      PlanSchema.parse({
        id,
        goal: `goal-${id}`,
        steps: [{ id: 's1', description: `step for ${id}` }],
        createdAt: 1_700_000_000 + i,
      }),
    )
  }
  await fs.writeFile(plansPath, JSON.stringify(store.toJSON(), null, 2), 'utf8')
}

describe('lumen plan list', () => {
  it('prints (no plans ...) when the file is missing', async () => {
    const code = await planListCommand({ file: plansPath })
    expect(code).toBe(0)
    expect(stdout).toContain('(no plans')
  })

  it('lists every plan, newest first, with status pending', async () => {
    await seed(['a', 'b', 'c'])
    const code = await planListCommand({ file: plansPath })
    expect(code).toBe(0)
    expect(stdout).toContain('Plans (3)')
    expect(stdout).toContain('- a  [pending]')
    expect(stdout).toContain('- b  [pending]')
    expect(stdout).toContain('- c  [pending]')
    // Newest first: c appears before a in the printed list.
    const cIdx = stdout.indexOf('- c  [pending]')
    const aIdx = stdout.indexOf('- a  [pending]')
    expect(cIdx).toBeLessThan(aIdx)
  })
})

describe('lumen plan approve', () => {
  it('marks the plan as approved and persists the change', async () => {
    await seed(['a', 'b'])
    const code = await planApproveCommand({ id: 'a', file: plansPath })
    expect(code).toBe(0)
    expect(stdout).toContain('approved a')

    const after = await planListCommand({ file: plansPath })
    expect(after).toBe(0)
    const aLine = stdout.split('\n').find((l) => l.includes('- a'))
    expect(aLine).toContain('approved')
  })

  it('records notes when provided', async () => {
    await seed(['a'])
    const code = await planApproveCommand({
      id: 'a',
      file: plansPath,
      notes: 'looks good',
    })
    expect(code).toBe(0)
    const raw = await fs.readFile(plansPath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const plan = (parsed as Array<{ id: string; notes?: string }>).find((p) => p.id === 'a')
    expect(plan?.notes).toBe('looks good')
  })

  it('returns exit 1 and writes to stderr when the plan id is unknown', async () => {
    await seed(['a'])
    const code = await planApproveCommand({ id: 'missing', file: plansPath })
    expect(code).toBe(1)
    expect(stderr).toContain('no plan with id "missing"')
  })
})

describe('lumen plan reject', () => {
  it('marks the plan as rejected and persists the change', async () => {
    await seed(['a', 'b'])
    const code = await planRejectCommand({ id: 'b', file: plansPath })
    expect(code).toBe(0)
    expect(stdout).toContain('rejected b')

    await planListCommand({ file: plansPath })
    const bLine = stdout.split('\n').find((l) => l.includes('- b'))
    expect(bLine).toContain('rejected')
  })

  it('returns exit 1 when the plan id is unknown', async () => {
    await seed(['a'])
    const code = await planRejectCommand({ id: 'missing', file: plansPath })
    expect(code).toBe(1)
    expect(stderr).toContain('no plan with id "missing"')
  })
})
