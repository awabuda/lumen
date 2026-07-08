---
"@lumen/core": minor
---

P20.3 — Context compression middleware (collapse long histories).

Adds `createContextCompressionMiddleware({ maxMessages?, keepLastN?, summaryFn? })`
to `@lumen/core`. When the message history exceeds `maxMessages`,
the middleware replaces the oldest `messages.length - keepLastN`
messages with a single system-role summary message followed by
the last `keepLastN` messages verbatim. The default `summaryFn`
is a deterministic 200-char truncation of the first discarded
message (no API call, no LLM dependency); callers can pass a
custom `summaryFn` for higher-quality LLM-backed summarisation.

7 new e2e in `test/middleware-context-compression.test.ts`:
under-cap pass-through / over-cap compress + keep-last-N /
custom summaryFn / keepLastN >= maxMessages rejected at
construction / Zod rejects non-positive numbers / middleware
name 'context-compression' / output is exactly summary + tail
size.

P19+ rule 11: middleware, not AgentConfig boolean.
P19+ rule 15: helper function + interface, not abstract class.
