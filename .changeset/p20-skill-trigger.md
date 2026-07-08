---
"@lumen/core": minor
---

P20.6 — Skill trigger middleware (lazy activation based on
user message content).

Adds `createSkillTriggerMiddleware({ trigger, maxActive?, formatActive? })`
to `@lumen/core`. The middleware walks the messages array,
finds the most recent user message, calls the caller-supplied
`trigger(text)` function, and prepends a system-role augmentation
listing the active skills. The trigger function is supplied by
the caller — typically composed with `@lumen/skills`'s
`KeywordTrigger` or `EmbeddingTrigger` — so the core package
stays tier-isolated (no import of `@lumen/skills`).

Algorithm:
  1. Find the most recent user-role message; bail out otherwise.
  2. Run `trigger(text)`.
  3. Truncate the result to `maxActive` (default 3).
  4. Format via `formatActive` (default: bullet list) and
     prepend as a system-role message.
  5. If the trigger returns no skills, pass through unchanged.

10 e2e in `test/middleware-skill-trigger.test.ts`: trigger
matches → augmentation prepended / no matches → pass through /
maxActive truncation / no user message → pass through / only
last user message is sent to the trigger / custom formatActive
/ middleware name 'skill-trigger' / Zod rejects non-positive
maxActive / missing trigger rejected by Zod / end-to-end
through `Agent.run` (createAgent factory) verifies the
augmentation reaches the provider.

P19+ rule 11: middleware, not AgentConfig boolean.
P19+ rule 15: helper function + interface, not abstract class.
