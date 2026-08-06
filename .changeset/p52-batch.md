---
"@lumen/skills": minor
---

P52.a — `SkillRegistry.applyActive` now substitutes
`${ARG[i]}` / `${ARGUMENTS}` placeholders in the
skill's `instructions` text with the positional
args supplied via `ctx.arguments`. The pre-P52.a
path did not parameterise skill templates. The
operator could not call a skill with positional
args (e.g. `/code-review <branch>`).

Placeholders supported:
  - `${ARG[0]}` / `${ARG[1]}` / ... — indexed
    positional substitution.
  - `${ARGUMENTS}` — joins the array with spaces
    (the pre-P52.a Claude Code convention).
  - Out-of-range placeholders are left
    untouched (the operator should see the
    raw `${ARG[1]}` in the output so they can
    fix the invocation).

The `SkillContext` schema gains an
`arguments: string[]` field. The
`SkillRegistry.applyActive` returns substituted
instructions when `ctx.arguments !== undefined`.
The `BaseSkill.apply(ctx)` interface is
unchanged (the substitution happens upstream,
in the registry) — this keeps the per-skill
contract stable.

Bug.md #67 follow-up. Test counts: skills
63 → 67 (+4); monorepo 1959 → 1963 (+4).
0 regressions introduced (7 pre-existing
failures + 1 tools pre-existing failure
remain FENCE-OFF).
