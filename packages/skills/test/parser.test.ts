/** Tests for the SKILL.md parser and MarkdownSkill adapter. */

import { describe, expect, it } from 'vitest'
import {
  buildTriggers,
  MarkdownSkill,
  parseFrontmatter,
  parseSkillMarkdown,
  slugify,
} from '../src/index.js'

const doc = `---
name: TypeScript Expert
description: Helps with strict TypeScript
version: 1.2.3
keywords: [typescript, ts strict]
triggers:
  - path:*.ts
  - always
tags:
  - dev
  - typescript
---
# TypeScript Expert

Prefer strict types and no any.
`

describe('parseFrontmatter', () => {
  it('parses scalar fields', () => {
    const fm = parseFrontmatter('name: Demo\ndescription: Hello')
    expect(fm).toEqual({ name: 'Demo', description: 'Hello' })
  })

  it('parses quoted strings', () => {
    const fm = parseFrontmatter('name: "Demo Skill"\ndescription: \'Hello\'')
    expect(fm).toEqual({ name: 'Demo Skill', description: 'Hello' })
  })

  it('parses inline arrays', () => {
    const fm = parseFrontmatter('keywords: [foo, "bar baz"]')
    expect(fm).toEqual({ keywords: ['foo', 'bar baz'] })
  })

  it('parses block arrays', () => {
    const fm = parseFrontmatter('keywords:\n  - foo\n  - bar')
    expect(fm).toEqual({ keywords: ['foo', 'bar'] })
  })

  it('throws on unsupported lines', () => {
    expect(() => parseFrontmatter('name Demo')).toThrow(/Unsupported/)
  })
})

describe('parseSkillMarkdown', () => {
  it('parses frontmatter and body', () => {
    const parsed = parseSkillMarkdown(doc)
    expect(parsed.frontmatter.name).toBe('TypeScript Expert')
    expect(parsed.frontmatter.keywords).toEqual(['typescript', 'ts strict'])
    expect(parsed.frontmatter.triggers).toEqual(['path:*.ts', 'always'])
    expect(parsed.body).toContain('Prefer strict')
  })

  it('requires opening delimiter', () => {
    expect(() => parseSkillMarkdown('name: x')).toThrow(/must start/)
  })

  it('requires closing delimiter', () => {
    expect(() => parseSkillMarkdown('---\nname: x')).toThrow(/must end/)
  })

  it('validates required name', () => {
    expect(() => parseSkillMarkdown('---\ndescription: no name\n---\nbody')).toThrow(
      /Invalid SKILL.md/,
    )
  })
})

describe('MarkdownSkill', () => {
  it('maps SKILL.md to descriptor and instructions', async () => {
    const parsed = parseSkillMarkdown(doc)
    const skill = new MarkdownSkill({ ...parsed, sourcePath: '/tmp/skill/SKILL.md' })
    expect(skill.id).toBe('typescript-expert')
    expect(skill.describe().sourcePath).toBe('/tmp/skill/SKILL.md')
    expect(skill.describe().version).toBe('1.2.3')

    const app = await skill.apply({ cwd: '/tmp', prompt: 'typescript' })
    expect(app.instructions[0]).toContain('Prefer strict')
  })

  it('activates by keyword', async () => {
    const parsed = parseSkillMarkdown(doc)
    const skill = new MarkdownSkill(parsed)
    const activation = await skill.shouldActivate({
      cwd: '/tmp',
      prompt: 'help with TypeScript types',
    })
    expect(activation.active).toBe(true)
    expect(activation.reason).toContain('keyword')
  })

  it('activates by path trigger', async () => {
    const parsed = parseSkillMarkdown(doc)
    const skill = new MarkdownSkill(parsed)
    const activation = await skill.shouldActivate({ cwd: '/tmp', pathHints: ['index.ts'] })
    expect(activation.active).toBe(true)
    expect(activation.reason).toContain('path')
  })

  it('falls back to name keyword when no triggers are supplied', async () => {
    const parsed = parseSkillMarkdown('---\nname: Docker\n---\nDocker skill body')
    const skill = new MarkdownSkill(parsed)
    const activation = await skill.shouldActivate({ cwd: '/tmp', prompt: 'use docker' })
    expect(activation.active).toBe(true)
  })
})

describe('buildTriggers', () => {
  it('turns frontmatter into canonical triggers', () => {
    const triggers = buildTriggers({
      name: 'Demo',
      keywords: ['foo'],
      triggers: ['path:*.md', 'always', 'bar'],
    })
    expect(triggers).toEqual([
      { kind: 'keyword', value: 'foo', weight: 0.75 },
      { kind: 'glob', value: '*.md', weight: 0.65 },
      { kind: 'always', value: '*', weight: 0.2 },
      { kind: 'keyword', value: 'bar', weight: 0.7 },
    ])
  })
})

describe('slugify', () => {
  it('creates stable lowercase ids', () => {
    expect(slugify(' TypeScript Expert! ')).toBe('typescript-expert')
  })

  it('keeps Chinese characters', () => {
    expect(slugify('简历 改写')).toBe('简历-改写')
  })
})
