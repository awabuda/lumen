---
"@lumen/cli": minor
---

P59 — `lumen chat` now falls back to the most
recent session in the SqliteStore when the
cwd-derived session id (`chat-<sha256>`) has no
matching session.

Pre-P59 the chat command always used the
cwd-derived id; if the cwd hash changed (e.g. a
different invocation path, a different
`path.resolve` normalisation, or a manual
`--session-id` override that landed before
P32.1), the operator's existing session was
orphaned — every `lumen chat` re-launch created
a fresh session, the chat log rendered empty,
and the agent said "this is the first message"
even though prior turns had landed in
`session_messages`.

P59 keeps the cwd-derived default for new
installs but adds a fallback for the
existing-session case: if no session with the
cwd-derived id exists, `resolveChatSessionId`
returns the most recent session id from
`listSessions`. The operator's prior
conversation is preserved without an explicit
`--resume` flag.

End-to-end verified (post-rebuild):
  resolved: chat-lo0y9LBpGF4
  (the operator's most recent session;
   cwd-derived `chat-HHzrqm7IefY` had no
   matching record in the SqliteStore.)

Test counts: cli 463 → 466 (+3 new). 0 new
pre-existing FENCE-OFF.
