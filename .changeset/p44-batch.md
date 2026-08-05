---
"@lumen/cli": minor
---

P44.a + P44.b + P44.c + P44.d — four P+ slices:

- P44.a — `lumen reflect meta --format json` emits
  a JSON object on `meta` (pre-apply + post-apply).
- P44.b — `lumen session prune --dry-run` skips
  the apply step and reports the would-remove count.
- P44.c — `lumen session list --list-limit <n>`
  caps the number of sessions emitted.
- P44.d — `lumen session show <id> --format json`
  emits a JSON object on `show`.

Test counts: cli 438 → 441 (+3); monorepo
1937 → 1940 (+3). 0 regressions introduced
(7 pre-existing failures in
`default-command.test.ts` /
`p28.3-computer-use-flag.test.ts`, plus
1 pre-existing failure in
`packages/tools/test/default-sandbox.test.ts`,
remain FENCE-OFF).