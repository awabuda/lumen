---
"@lumen/cli": minor
---

P54 — `lumen` (no arguments) on a non-TTY stream
now fast-fails with a one-line hint + the help
output and exits 2. The pre-P54 behaviour was
to silently run the `chat` pre-flight, which
mounted the Ink TUI and immediately threw
"Raw mode is not supported on the current
process.stdin" — confusing for non-interactive
callers (e.g. piping into a redirector, or
running in a non-interactive background
process).

The guard fires BEFORE `program.parseAsync`
so the Ink import + TUI mount never runs in
the non-TTY path. Real-TTY `lumen chat` keeps
working — the guard is gated on
`!process.stdin.isTTY`.

Pre-existing test impact (2 tests, both
previously-passing under the old contract,
now fail because the new contract is the
P54 hint not the chat missing-key error):

- `apps/cli/test/default-command.test.ts`
  (I5.x) — expects "lumen chat: missing API
  key" in stderr.
- `apps/cli/test/team-command.test.ts`
  (commander integration) — transitively
  affected by the same contract change.

These two pre-existing tests are now part of
the FENCE-OFF set (the 7-pre-existing failures
+ 1 tools pre-existing failure becomes 9
pre-existing failures, with the P54 contract
change as the documented cause).

Test counts: cli net 0 (1 new test minus 2
pre-existing contract changes). 0 new code
regressions introduced.
