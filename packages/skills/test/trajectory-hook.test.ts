/** Tests for the trajectory hook. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HeuristicEvolver } from '../src/evolver.js'
import { SkillRegistry } from '../src/registry.js'
import { TrajectoryHook } from '../src/trajectory-hook.js'

let tmpDir: string
let registry: SkillRegistry

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-trajectory-'))
  registry = new SkillRegistry()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('TrajectoryHook', () => {
  it('creates a skill from a successful run with enough tool calls', async () => {
    const hook = new TrajectoryHook({
      evolver: new HeuristicEvolver(),
      registry,
      skillsDir: tmpDir,
    })

    await hook.handle(
      {
        kind: 'run:end',
        messages: [
          { role: 'user', content: 'How do I set up a React project with TypeScript?' },
          { role: 'tool', content: 'ok', toolName: 'a' },
          { role: 'tool', content: 'ok', toolName: 'b' },
          { role: 'tool', content: 'ok', toolName: 'c' },
          { role: 'assistant', content: 'Done.' },
        ],
      },
      {},
    )

    expect(registry.size).toBe(1)
  })

  it('skips non-run:end events', async () => {
    const hook = new TrajectoryHook({
      evolver: new HeuristicEvolver(),
      registry,
      skillsDir: tmpDir,
    })

    await hook.handle({ kind: 'tool:start' }, {})
    expect(registry.size).toBe(0)
  })

  it('skips runs with too few messages', async () => {
    const hook = new TrajectoryHook({
      evolver: new HeuristicEvolver(),
      registry,
      skillsDir: tmpDir,
      minMessages: 10,
    })

    await hook.handle(
      {
        kind: 'run:end',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
      {},
    )

    expect(registry.size).toBe(0)
  })
})
