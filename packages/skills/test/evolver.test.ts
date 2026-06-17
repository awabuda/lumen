/** Tests for the skill evolver. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ChatMessage, HeuristicEvolver } from '../src/evolver.js'
import { SkillRegistry } from '../src/registry.js'

let tmpDir: string
let registry: SkillRegistry

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-evolver-'))
  registry = new SkillRegistry()
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('HeuristicEvolver', () => {
  it('creates a skill when ≥3 tool calls were made', async () => {
    const evolver = new HeuristicEvolver()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'How do I set up a React project with TypeScript and pnpm?' },
      { role: 'assistant', content: 'Let me check the docs.' },
      { role: 'tool', content: 'result', toolCallId: '1', toolName: 'search' },
      { role: 'assistant', content: 'Found the setup guide.' },
      { role: 'tool', content: 'result', toolCallId: '2', toolName: 'read_file' },
      { role: 'assistant', content: 'Now installing...' },
      { role: 'tool', content: 'result', toolCallId: '3', toolName: 'terminal' },
      { role: 'assistant', content: 'Done! React + TS + pnpm project created.' },
    ]
    const result = await evolver.evolve(messages, registry, tmpDir)
    expect(result.created).toBe(true)
    expect(result.skill).toBeDefined()
    expect(registry.size).toBe(1)
  })

  it('skips when fewer than 3 tool calls', async () => {
    const evolver = new HeuristicEvolver()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'What is the capital of France?' },
      { role: 'assistant', content: 'Paris.' },
    ]
    const result = await evolver.evolve(messages, registry, tmpDir)
    expect(result.created).toBe(false)
    expect(result.reason).toContain('tool calls')
  })

  it('skips when task description is too short', async () => {
    const evolver = new HeuristicEvolver()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'ok', toolName: 'a' },
      { role: 'tool', content: 'ok', toolName: 'b' },
      { role: 'tool', content: 'ok', toolName: 'c' },
    ]
    const result = await evolver.evolve(messages, registry, tmpDir)
    expect(result.created).toBe(false)
    expect(result.reason).toContain('short')
  })

  it('writes a SKILL.md file to disk', async () => {
    const evolver = new HeuristicEvolver()
    const messages: ChatMessage[] = [
      { role: 'user', content: 'How do I set up a React project with TypeScript?' },
      { role: 'tool', content: 'ok', toolName: 'a' },
      { role: 'tool', content: 'ok', toolName: 'b' },
      { role: 'tool', content: 'ok', toolName: 'c' },
      { role: 'assistant', content: 'Done.' },
    ]
    const result = await evolver.evolve(messages, registry, tmpDir)
    expect(result.created).toBe(true)
    const files = await fs.readdir(tmpDir)
    expect(files.length).toBeGreaterThan(0)
  })
})
