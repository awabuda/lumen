/** P22.3 — `lumen init` and `lumen permissions show` command tests. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initCommand, starterPermissionPolicy } from '../src/commands/init.js'
import {
  permissionsAuditCommand as audit,
  permissionsPresetCommand as preset,
  permissionsShowCommand as show,
} from '../src/commands/permissions.js'

let workDir = ''
let stdout = ''
let stderr = ''
const origStdout = process.stdout.write.bind(process.stdout)
const origStderr = process.stderr.write.bind(process.stderr)

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p22-3-'))
  stdout = ''
  stderr = ''
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
})

afterEach(async () => {
  process.stdout.write = origStdout
  process.stderr.write = origStderr
  await fs.rm(workDir, { recursive: true, force: true })
})

describe('initCommand', () => {
  it('writes the starter file at the given path', async () => {
    const dest = path.join(workDir, 'policy.yaml')
    const code = await initCommand({ path: dest })
    expect(code).toBe(0)
    const text = await fs.readFile(dest, 'utf8')
    expect(text).toBe(starterPermissionPolicy())
    expect(stdout).toContain(dest)
  })

  it('exits 2 when the file already exists and --force is not set', async () => {
    const dest = path.join(workDir, 'policy.yaml')
    await fs.writeFile(dest, 'preset', 'utf8')
    const code = await initCommand({ path: dest })
    expect(code).toBe(2)
    expect(stderr).toContain('lumen init: file already exists')
    expect(await fs.readFile(dest, 'utf8')).toBe('preset')
  })

  it('overwrites the file when --force is set', async () => {
    const dest = path.join(workDir, 'policy.yaml')
    await fs.writeFile(dest, 'old', 'utf8')
    const code = await initCommand({ path: dest, force: true })
    expect(code).toBe(0)
    expect(await fs.readFile(dest, 'utf8')).toBe(starterPermissionPolicy())
  })

  it('creates the parent directory if it does not exist', async () => {
    const dest = path.join(workDir, 'nested', 'deeper', 'policy.yaml')
    const code = await initCommand({ path: dest })
    expect(code).toBe(0)
    expect((await fs.stat(dest)).isFile()).toBe(true)
  })
})

describe('permissionsShowCommand', () => {
  it('prints the resolved policy in human-readable form', async () => {
    const dest = path.join(workDir, 'policy.yaml')
    await initCommand({ path: dest })
    stdout = ''
    const code = await show({ path: dest })
    expect(code).toBe(0)
    expect(stdout).toContain('version: 1')
    expect(stdout).toContain('default: ask')
    expect(stdout).toContain('allow-read-file')
    expect(stdout).toContain('decision: allow')
    expect(stdout).toContain('deny-terminal')
  })

  it('emits JSON when --json is set', async () => {
    const dest = path.join(workDir, 'policy.yaml')
    await initCommand({ path: dest })
    stdout = ''
    const code = await show({ path: dest, json: true })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { version: number; default: string; rules: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.default).toBe('ask')
    expect(parsed.rules.length).toBeGreaterThan(0)
  })

  it('exits 1 with a hint when the file does not exist', async () => {
    const dest = path.join(workDir, 'no-such.yaml')
    const code = await show({ path: dest })
    expect(code).toBe(1)
    expect(stderr).toContain('lumen permissions show: no policy file at')
    expect(stderr).toContain('lumen init')
  })
})

describe('permissionsPresetCommand', () => {
  it('prints the same text that initCommand writes to disk', async () => {
    const code = await preset()
    expect(code).toBe(0)
    expect(stdout).toBe(starterPermissionPolicy())
  })
})

describe('permissionsAuditCommand (P22.6.3)', () => {
  const writePolicy = async (name: string, text: string): Promise<string> => {
    const p = path.join(workDir, name)
    await fs.writeFile(p, text, 'utf8')
    return p
  }

  it('exits 1 with a hint when the file does not exist', async () => {
    const code = await audit({ path: path.join(workDir, 'no-such-audit.yaml') })
    expect(code).toBe(1)
    expect(stderr).toContain('lumen permissions audit: no policy file at')
  })

  it('emits JSON with one entry per rule and a source hash', async () => {
    const file = await writePolicy(
      'audit-json.yaml',
      `version: 1
default: ask
rules:
  - name: r1
    tools: [read_file]
    decision: allow
`,
    )
    stdout = ''
    const code = await audit({ path: file, format: 'json' })
    expect(code).toBe(0)
    const report = JSON.parse(stdout) as {
      policy: string
      entries: Array<{ rule: string; source: string; sourceHash: string }>
    }
    expect(report.policy).toBe(file)
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]?.rule).toBe('r1')
    expect(report.entries[0]?.source).toBe(file)
    expect(report.entries[0]?.sourceHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('emits CSV with a header row and one row per rule', async () => {
    const file = await writePolicy(
      'audit-csv.yaml',
      `version: 1
default: ask
rules:
  - name: r1
    tools: [read_file]
    decision: allow
  - name: r2
    tools: [write_file]
    decision: deny
`,
    )
    stdout = ''
    const code = await audit({ path: file, format: 'csv' })
    expect(code).toBe(0)
    const lines = stdout.trim().split('\n')
    expect(lines[0]).toBe('rule,tools,decision,source,sourceHash')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/r1,read_file,allow,.*[a-f0-9]{64}/)
    expect(lines[2]).toMatch(/r2,write_file,deny,.*[a-f0-9]{64}/)
  })

  it('emits human-readable form by default with a generatedAt timestamp', async () => {
    const file = await writePolicy(
      'audit-human.yaml',
      `version: 1
default: ask
rules:
  - name: r1
    tools: [read_file]
    decision: allow
`,
    )
    stdout = ''
    const code = await audit({ path: file })
    expect(code).toBe(0)
    expect(stdout).toContain('# lumen permissions audit')
    expect(stdout).toContain(`policy: ${file}`)
    expect(stdout).toContain('generatedAt:')
    expect(stdout).toContain('- r1')
    expect(stdout).toMatch(/sourceHash: [a-f0-9]{64}/)
  })
})

// Reference the re-export so eslint does not flag the unused import.
void audit
void starterPermissionPolicy
