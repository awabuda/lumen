---
"@lumen/core": minor
---

P58 — when `lumen chat` re-opens a session
(the typical case: the user closed the TUI
after a successful `success` / `error` event
and the in-progress checkpoint was cleared),
the agent now hydrates the conversation context
from the `session_messages` table.

Pre-P58 the agent always started fresh
(`[system, user]`), even though every prior
turn was sitting in `session_messages`. The
TUI's P57 effect reads the same rows for the
chat log; P58 closes the loop so the agent
also sees them as part of conversation
context. End-to-end this means the agent
answers "what was my previous question?" with
a real prior turn, not "this is the start of
the conversation".

Implementation:
1. `Agent.hydrateMessagesFromSession` (private
   method) wraps the `getSessionMessages` call
   with a try/catch (best-effort: a corrupted
   memory file is not the agent's problem) and
   maps the slim `SessionMessage` rows into the
   live `Message` array.
2. `Agent.executeLoop` gains a third branch in
   the messages init: `checkpoint ?? hydratedFrom
   Session ?? [system, user]`. The P32.2 fast
   path is preserved; the P58 fallback takes over
   when the checkpoint is missing.

Test counts: core 668 → 670 (+2); monorepo
1962 → 1964 (+2). 0 new code regressions.
