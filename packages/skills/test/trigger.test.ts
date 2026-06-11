/** Tests for skill triggers. */

import { describe, expect, it } from 'vitest'
import { KeywordTrigger, EmbeddingTrigger } from '../src/trigger.js'
import type { BaseSkill, SkillTrigger } from '../src/base.js'

const toTriggers = (words: string[]): SkillTrigger[] =>
  words.map((w) => ({ kind: 'keyword' as const, value: w, weight: 0.7 }))

// Minimal fake skill for testing.
const fakeSkill = (name: string, triggerWords: string[], description: string): BaseSkill => ({
  id: name,
  name,
  description,
  version: '1.0.0',
  triggers: toTriggers(triggerWords),
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async execute(): Promise<unknown> {
    return { ok: true }
  },
})

describe('KeywordTrigger', () => {
  it('matches a skill whose trigger word appears in the message', async () => {
    const trigger = new KeywordTrigger()
    const skills = [fakeSkill('git', ['git', 'commit'], 'Git operations')]
    const results = await trigger.trigger('I need to git commit', skills)
    expect(results).toHaveLength(1)
    expect(results[0]?.skill.id).toBe('git')
    expect(results[0]?.score).toBeGreaterThan(0)
  })

  it('returns empty when no trigger words match', async () => {
    const trigger = new KeywordTrigger()
    const skills = [fakeSkill('git', ['git'], 'Git ops')]
    const results = await trigger.trigger('hello world', skills)
    expect(results).toEqual([])
  })

  it('scores 1.0 when all trigger words match', async () => {
    const trigger = new KeywordTrigger()
    const skills = [fakeSkill('git', ['git', 'commit'], 'Git ops')]
    const results = await trigger.trigger('git commit', skills)
    expect(results[0]?.score).toBe(1)
  })

  it('scores 0.5 when half the trigger words match', async () => {
    const trigger = new KeywordTrigger()
    const skills = [fakeSkill('git', ['git', 'commit'], 'Git ops')]
    const results = await trigger.trigger('git status', skills)
    expect(results[0]?.score).toBe(0.5)
  })

  it('skips skills with no keyword triggers', async () => {
    const trigger = new KeywordTrigger()
    const skills: BaseSkill[] = [{
      id: 'empty', name: 'empty', description: 'No triggers',
      version: '1.0.0',
      triggers: [],
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute(): Promise<unknown> { return { ok: true } },
    }]
    const results = await trigger.trigger('anything', skills)
    expect(results).toEqual([])
  })

  it('respects topK', async () => {
    const trigger = new KeywordTrigger()
    const skills = [
      fakeSkill('a', ['a'], 'A'),
      fakeSkill('b', ['b'], 'B'),
      fakeSkill('c', ['c'], 'C'),
    ]
    const results = await trigger.trigger('a b c', skills, 2)
    expect(results).toHaveLength(2)
  })
})

describe('EmbeddingTrigger', () => {
  it('returns results when embed returns valid vectors', async () => {
    const embed = async (text: string): Promise<ReadonlyArray<number>> => {
      return [text.charCodeAt(0) % 10, text.length % 10]
    }
    const trigger = new EmbeddingTrigger(embed)
    const skills = [fakeSkill('a', [], 'alpha'), fakeSkill('b', [], 'beta')]
    const results = await trigger.trigger('alpha query', skills)
    expect(results.length).toBeGreaterThan(0)
  })

  it('returns empty when embed throws', async () => {
    const embed = async (): Promise<ReadonlyArray<number>> => {
      throw new Error('embed failed')
    }
    const trigger = new EmbeddingTrigger(embed)
    const skills = [fakeSkill('a', [], 'alpha')]
    const results = await trigger.trigger('hello', skills)
    expect(results).toEqual([])
  })

  it('returns empty when embed returns empty array', async () => {
    const embed = async (): Promise<ReadonlyArray<number>> => []
    const trigger = new EmbeddingTrigger(embed)
    const skills = [fakeSkill('a', [], 'alpha')]
    const results = await trigger.trigger('hello', skills)
    expect(results).toEqual([])
  })
})
