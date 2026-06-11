/**
 * Skill auto-evolution — create new skills from successful
 * agent runs.
 *
 * After the agent completes a multi-turn interaction, the
 * evolver inspects the conversation and decides whether a
 * new skill should be created. If so, it generates a
 * SKILL.md file and registers it in the registry.
 *
 * Two strategies ship here:
 *   - {@link HeuristicEvolver} — rule-based: creates a
 *     skill when the run had ≥3 tool calls and ended
 *     successfully. Uses a template to generate the
 *     SKILL.md content.
 *   - {@link LLMEvolver} — asks the LLM to generate a
 *     skill from the conversation transcript.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BaseProvider, ChatMessage } from '@lumen/core'
import type { BaseSkill } from './base.js'
import type { SkillRegistry } from './registry.js'
import { MarkdownSkill } from './markdown-skill.js'
import { parseSkillMarkdown } from './parser.js'

/** Result of an evolution attempt. */
export interface EvolutionResult {
  /** Whether a new skill was created. */
  readonly created: boolean
  /** The new skill, if created. */
  readonly skill?: BaseSkill
  /** Human-readable reason. */
  readonly reason: string
}

/** The contract every evolver implements. */
export abstract class BaseEvolver {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /**
   * Inspect a completed agent run and optionally create
   * a new skill. The skill is written to `skillsDir` and
   * registered in the `registry`.
   */
  public abstract evolve(
    messages: ReadonlyArray<ChatMessage>,
    registry: SkillRegistry,
    skillsDir: string,
  ): Promise<EvolutionResult>
}

// ---------------------------------------------------------------------------
// HeuristicEvolver — rule-based
// ---------------------------------------------------------------------------

/**
 * Creates a skill when the run meets these criteria:
 *   - ≥3 tool calls were made (indicating a non-trivial task)
 *   - The final assistant message is not an error
 *   - The task description is ≥10 characters
 *
 * The generated SKILL.md uses a simple template with the
 * task description as the trigger word.
 */
export class HeuristicEvolver extends BaseEvolver {
  public readonly id = 'heuristic'

  public async evolve(
    messages: ReadonlyArray<ChatMessage>,
    registry: SkillRegistry,
    skillsDir: string,
  ): Promise<EvolutionResult> {
    // Count tool calls.
    const toolCalls = messages.filter((m) => m.role === 'tool').length
    if (toolCalls < 3) {
      return { created: false, reason: `Only ${toolCalls} tool calls (need ≥3)` }
    }

    // Get the user's original request.
    const userMsg = messages.find((m) => m.role === 'user')
    const task = typeof userMsg?.content === 'string' ? userMsg.content.trim() : ''
    if (task.length < 10) {
      return { created: false, reason: 'Task description too short' }
    }

    // Get the final assistant response.
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    const summary = typeof lastAssistant?.content === 'string'
      ? lastAssistant.content.slice(0, 200)
      : 'Task completed successfully.'

    // Generate a slug from the task.
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50)

    const skillId = `auto-${slug}`
    const skillName = task.slice(0, 60)
    const triggerWord = task.split(' ').slice(0, 3).join(' ').toLowerCase()

    const markdown = [
      '---',
      `id: ${skillId}`,
      `name: ${skillName}`,
      `version: 1.0.0`,
      'keywords:',
      `  - "${triggerWord}"`,
      '---',
      '',
      `# ${skillName}`,
      '',
      summary,
      '',
      '## Steps',
      '',
      ...messages
        .filter((m) => m.role === 'assistant' && typeof m.content === 'string')
        .slice(0, 5)
        .map((m, i) => `${i + 1}. ${(m.content as string).slice(0, 120)}`),
      '',
      '## Tools used',
      '',
      ...messages
        .filter((m) => m.role === 'tool')
        .map((m) => `- \`${m.toolName ?? 'unknown'}\``),
    ].join('\n')

    // Write the SKILL.md file.
    const skillDir = path.join(skillsDir, skillId)
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), markdown, 'utf-8')

    // Parse and register.
    const parsed = parseSkillMarkdown(markdown)
    const skill = new MarkdownSkill({
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      sourcePath: skillDir,
    })
    registry.register(skill)

    return { created: true, skill, reason: `Created skill "${skillId}" from ${toolCalls} tool calls` }
  }
}

// ---------------------------------------------------------------------------
// LLMEvolver — ask the model
// ---------------------------------------------------------------------------

/**
 * Asks the LLM to generate a SKILL.md from the conversation.
 * Sends the transcript and a system prompt instructing the
 * model to output valid YAML frontmatter + markdown body.
 *
 * If the LLM call fails or returns unparseable output, the
 * evolver returns `created: false`.
 */
export class LLMEvolver extends BaseEvolver {
  public readonly id = 'llm'
  private readonly provider: BaseProvider
  private readonly model: string

  public constructor(provider: BaseProvider, model = 'gpt-4o-mini') {
    super()
    this.provider = provider
    this.model = model
  }

  public async evolve(
    messages: ReadonlyArray<ChatMessage>,
    registry: SkillRegistry,
    skillsDir: string,
  ): Promise<EvolutionResult> {
    const transcript = messages
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n')

    const prompt = [
      'You are a skill extraction assistant. Given a conversation transcript,',
      'generate a SKILL.md file in the following format:',
      '',
      '```markdown',
      '---',
      'id: <kebab-case-id>',
      'name: <short name>',
      'version: 1.0.0',
      'triggers:',
      '  - kind: keyword',
      '    value: "<trigger phrase>"',
      '    weight: 0.6',
      '---',
      '',
      '# <name>',
      '',
      '<description>',
      '',
      '## Steps',
      '',
      '1. ...',
      '2. ...',
      '```',
      '',
      'Only output the SKILL.md content, nothing else.',
      '',
      'Transcript:',
      transcript,
    ].join('\n')

    try {
      const response = await this.provider.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      })
      const text = response.content
      if (!text || text.length < 50) {
        return { created: false, reason: 'LLM returned empty or short response' }
      }

      // Extract frontmatter id.
      const idMatch = text.match(/^id:\s*(.+)$/m)
      const skillId = idMatch?.[1]?.trim() ?? `auto-${Date.now()}`

      const skillDir = path.join(skillsDir, skillId)
      await fs.mkdir(skillDir, { recursive: true })
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), text, 'utf-8')

      const parsed = parseSkillMarkdown(text)
      const skill = new MarkdownSkill({
        frontmatter: parsed.frontmatter,
        body: parsed.body,
        sourcePath: skillDir,
      })
      registry.register(skill)

      return { created: true, skill, reason: `LLM-generated skill "${skillId}"` }
    } catch (err) {
      return { created: false, reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}
