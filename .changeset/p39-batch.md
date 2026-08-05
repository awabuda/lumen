---
"@lumen/cli": minor
---

P39.a + P39.b + P39.c + P39.d — four P+ slices:

- P39.a — `lumen plan show <id> [--format human|json]`
  new subcommand. Reads the JSON plans file and
  prints the full Plan shape.
- P39.b — `lumen memory show --format json` emits
  the bridge descriptor as JSON. Reuses the
  existing `--format` flag from P38.b (P39.b was
  initially going to add a duplicate option;
  the conflict was caught during the e2e check and
  removed).
- P39.c — `lumen team validate <path> --format json`
  emits a JSON object on validate. Reuses the
  existing `--format` flag from P34.6.
- P39.d — `lumen config get --path <dotted-path>`
  new subcommand. Reads a single value out of the
  resolved + redacted config. Returns the value
  on stdout or `null` if the path does not exist.

Test counts: cli 420 → 425 (+5); monorepo
1919 → 1924 (+5). 0 regressions introduced by
P39 (7 pre-existing failures in
`default-command.test.ts` and
`p28.3-computer-use-flag.test.ts` are FENCE-OFF).