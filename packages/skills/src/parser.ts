/**
 * SKILL.md parser.
 *
 * Lumen intentionally avoids a YAML dependency for the first version. The
 * parser supports the narrow frontmatter shape skills need: string scalars,
 * inline arrays, and block string arrays.
 */

import { z } from 'zod'
import { SkillParseError } from './errors.js'

/** Zod schema for supported SKILL.md frontmatter. */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
})
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

/** Zod schema for a parsed SKILL.md document. */
export const ParsedSkillMarkdownSchema = z.object({
  frontmatter: SkillFrontmatterSchema,
  body: z.string(),
})
export type ParsedSkillMarkdown = z.infer<typeof ParsedSkillMarkdownSchema>

/** Parse a SKILL.md document into frontmatter and markdown body. */
export const parseSkillMarkdown = (input: string): ParsedSkillMarkdown => {
  const normalized = input.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    throw new SkillParseError('SKILL.md must start with YAML frontmatter delimiter "---"')
  }

  const end = normalized.indexOf('\n---\n', 4)
  if (end === -1) {
    throw new SkillParseError('SKILL.md frontmatter must end with delimiter "---"')
  }

  const frontmatterText = normalized.slice(4, end)
  const body = normalized.slice(end + 5).trimStart()
  const raw = parseFrontmatter(frontmatterText)
  const parsed = SkillFrontmatterSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new SkillParseError(`Invalid SKILL.md frontmatter: ${issues}`)
  }
  return { frontmatter: parsed.data, body }
}

/** Parse the supported frontmatter subset into unknown values. */
export const parseFrontmatter = (text: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  const lines = text.split('\n')
  let currentArrayKey: string | undefined

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item && currentArrayKey) {
      const value = item[1]
      if (value === undefined) continue
      const arr = out[currentArrayKey]
      if (Array.isArray(arr)) arr.push(unquote(value.trim()))
      continue
    }

    currentArrayKey = undefined
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) throw new SkillParseError(`Unsupported frontmatter line: ${line}`)

    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined) continue
    if (value.trim() === '') {
      out[key] = []
      currentArrayKey = key
      continue
    }
    out[key] = parseScalarOrInlineArray(value.trim())
  }

  return out
}

const parseScalarOrInlineArray = (value: string): string | string[] => {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner
      .split(',')
      .map((part) => unquote(part.trim()))
      .filter((part) => part.length > 0)
  }
  return unquote(value)
}

const unquote = (value: string): string => {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}
