# @lumen/skills

Reusable operating knowledge for Lumen agents. A "skill" is a
`SKILL.md` document with a typed frontmatter (triggers, capabilities,
linked files) plus optional companion files. The agent runtime
discovers skills from `~/.lumen/skills/` (or any path the caller
configures) and applies them when a trigger matches the conversation
context.

`@lumen/skills` deliberately does not import `@lumen/core` — skills
can be loaded and tested independently from the agent runtime.

## Quick start

```ts
import {
  FilesystemSkillSource,
  SkillRegistry,
  parseSkillMarkdown,
  MarkdownSkill,
  buildTriggers,
} from '@lumen/skills'

const source = new FilesystemSkillSource({
  root: '~/.lumen/skills',
})
const registry = new SkillRegistry()
await registry.loadFrom(source)
```

## Triggering

Triggers are matched by keyword or by embedding similarity:

```ts
const skill = new MarkdownSkill({
  frontmatter: parsedFrontmatter,
  body: parsedBody,
  triggers: buildTriggers(parsedFrontmatter.triggers),
})

const activations = await skill.match({ query: '...', embedding: ... })
```

Skill auto-evolution (P–F4.x) records trajectory hooks so a skill can
rewrite itself after observing successful runs.

## License

MIT
