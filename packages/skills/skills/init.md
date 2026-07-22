---
name: init
description: Scan the current project for build commands, directory layout, and dependencies, then emit a compact `CLAUDE.md`-style factsheet for the agent.
triggers:
  - kind: keyword
    value: /init
    weight: 0.9
  - kind: keyword
    value: initialize project context
  - kind: keyword
    value: bootstrap my project
---

# /init Skill (lightweight doc-only version)

> P23.11 — `/init` skill. The real `/init` would run a
> `ProjectAnalyzer` over the working directory (build commands,
> test runners, package layout). P23.11 ships only the
> skill scaffold + trigger surface; the analyzer is left to
> a follow-up P-ticket because it touches the network (npm
> registry lookups), the filesystem (deep walk), and
> potentially the LLM (synthesising a project summary).
>
> This `SKILL.md` lets users register `/init` already so the
> trigger surface lands; the analyzer body is appended when
> the P24 ticket lands.

## Usage

When the user runs `/init`:

1. Detect the package manager (`package.json` →
   `packageManager` field, else heuristic).
2. Enumerate top-level dirs (`src/`, `test/`, `docs/`).
3. Detect test runners (`pnpm test`, `npm test`, etc.).
4. Emit a compact markdown factsheet as the skill instruction.

## Notes

- The skill scaffolds the trigger; until the analyzer ships,
  `apply()` returns a placeholder that lists what *would* be
  detected. Operators should not enable this skill in
  production until the analyzer lands.
