---
"@lumen/core": minor
---

P60 — `Agent.hydrateMessagesFromSession` now
caps the number of prior `session_messages`
rows the agent loads into the conversation
context to a sliding window of 20. Pre-P60 the
limit was 1000, which on long-lived sessions
(e.g. the cwd-derived `chat-lo0y9LBpGF4` with
800+ rows accumulated across 6 days) caused
the agent to model its reply on the entire
history instead of the most-recent turn. The
"答非所问 / 这是第一条消息" symptom on the
default `lumen chat` cwd-derived session
resolved after this fix: the new user input
("你好") is no longer drowned out by hundreds
of prior "刚才让你干什么了" turns.

P60 also closes a second P58 regression: the
hydrated branch of `executeLoop` previously
forgot to append `options.userMessage` to the
hydrated array. The fresh-start branch already
appended the user row, but the hydrate branch
silently skipped it — the model never saw the
user's actual question and answered from
mid-history. P60 restores parity between the
two branches so the chat provider always
receives `hydrated... + newUserMessage` in
chronological order.

The new `MAX_HYDRATE_MESSAGES` constant is
exported from `@lumen/core` (`Agent.MAX_HYDRATE_MESSAGES`
is also accessible for convenience) so the cap
can be tuned without grepping the call sites.
The default of 20 covers ~10 turns of
back-and-forth — enough for the operator's
immediate prior conversation to land in
context, small enough that the model's
attention stays on the current turn.

Caveats: the companion `apps/cli` TUI (the
`Chat.tsx` P57 effect) still reads up to 1000
prior rows for the chat-log render; the agent
context is now bounded but the TUI scrollback
is not. That second-class fix is left for a
follow-up P-ticket because it changes the TUI
surface, not the agent semantics.