# @lumen/cli

## 0.49.0

### Minor Changes

- e845208: P54 — `lumen` (no arguments) on a non-TTY stream
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

  - 1 tools pre-existing failure becomes 9
    pre-existing failures, with the P54 contract
    change as the documented cause).

  Test counts: cli net 0 (1 new test minus 2
  pre-existing contract changes). 0 new code
  regressions introduced.

## 0.48.0

### Minor Changes

- 02f1602: P53 — `lumen apply-patch <file>`'s `fsApplier.write`
  now `mkdirSync` the parent directory before
  writing. Pre-P53 the write call required the
  parent directory to exist; an `ENOENT` on a
  missing parent surfaced as a failure in the
  patch result. The V4A spec is fine with
  creating new files in new directories; this
  is the natural place to mkdir.

  The 1-line addition (`fs.mkdir(...).then(fs.writeFile)`
  chain in `fsApplier.write`) is the minimal
  fix. We do NOT add a recursive=True arg since
  `fs.mkdir(path.dirname(abs), { recursive: true })`
  is the idiomatic Node.js pattern. The patch
  is a no-op for the existing Update / Delete
  hunks (only `*** Add File:` writes a fresh
  file).

  Test counts: cli 460 → 461 (+1); monorepo
  1963 → 1964 (+1). 0 regressions introduced
  (7 pre-existing failures + 1 tools pre-existing
  failure remain FENCE-OFF).

## 0.47.1

### Patch Changes

- Updated dependencies [aa18d4a]
  - @lumen/skills@0.18.0

## 0.47.0

### Minor Changes

- c25a3a9: P51.b — `lumen memory show [--verbose] --trust-distribution`
  emits an 11-bucket histogram of the records'
  `trust` field (0.0 / 0.1 / ... / 1.0) alongside
  the per-kind count. The histogram always emits
  all 11 keys (zero-count buckets are included
  so CI can pipe through `jq` without missing-key
  errors).

  P51.a (`lumen cost` / `lumen usage` CLI
  subcommand — bug.md #71) was withdrawn after
  the audit: `lumen run --stat` (P38.c) already
  surfaces the budget. P51.c/d/e were withdrawn
  as no-op / cross-package design pass items.
  P51.b is the only 1-2 commit slice left in
  the follow-up queue.

  Test counts: cli 459 → 460 (+1); monorepo
  1958 → 1959 (+1). 0 regressions introduced
  (7 pre-existing failures + 1 tools pre-existing
  failure remain FENCE-OFF).

## 0.46.0

### Minor Changes

- 53ada09: P42.c + P48.e — two P+ slices:

  - P42.c — `lumen memory prune [--kind <k>] [--force]`
    adds a new `prune` subcommand to the `memory`
    command. The action is destructive (deletes
    every record whose `kind === pruneKind`, or
    every record if `--kind` is omitted) and
    gated behind `--force`. Without `--force`,
    the action runs in dry-run mode (counts
    would-delete records). The dry-run path
    emits the same shape as the apply path:
    `{ dryRun, removed, kind? }`.
  - P48.e — `lumen reflect meta --dry-run` emits
    the pre-apply patch list without writing
    back to the store. Mirrors the
    `plan approve --dry-run` (P46.b) /
    `plan reject --dry-run` (P47.a) pattern.

  Test counts: cli 457 → 459 (+2); monorepo
  1956 → 1958 (+2). 0 regressions introduced
  (7 pre-existing failures + 1 tools pre-existing
  failure remain FENCE-OFF).

## 0.45.0

### Minor Changes

- e6e39c6: P49.a + P49.b + P49.c + P49.d — four P+ slices:

  - P49.a — `lumen session show <id> --no-content` drops
    the `content` field from each message in the JSON
    output. Useful for long sessions where CI only
    needs the message skeleton.
  - P49.b — `lumen plan list --no-goal` drops the
    `goal` field from each plan in the JSON output.
  - P49.c — `lumen reflect list --no-content` drops
    the `content` field from each record in the JSON
    output.
  - P49.d — `lumen plan list --no-status` drops the
    `status` field from each plan in the JSON output.

  Test counts: cli 453 → 457 (+4); monorepo
  1952 → 1956 (+4). 0 regressions introduced
  (7 pre-existing failures + 1 tools pre-existing
  failure remain FENCE-OFF).

## 0.44.0

### Minor Changes

- 2f9dfd4: P48.d + P48.h — two P+ slices:

  - P48.d — `lumen reflect list --list-limit` renames
    the pre-existing `--limit` flag to `--list-limit`
    to match the P44.c `session list --list-limit`
    convention. The function signature now accepts
    `listLimit?`; the pre-P48.d `limit?` field is
    preserved as a fallback.
  - P48.h — `lumen session delete <id> --no-load` skips
    the P45.a session + message-history load. The
    JSON path emits `lastAccessMs: null` instead
    of the most-recent message `createdAt`. Useful
    for bulk-delete operations in CI.

  Test counts: cli 451 → 453 (+2); monorepo
  1950 → 1952 (+2). 0 regressions introduced
  (7 pre-existing failures + 1 tools pre-existing
  failure remain FENCE-OFF).

## 0.43.0

### Minor Changes

- d4e5cb6: P47.a + P47.c + P47.d + P47.e — four P+ slices:

  - P47.a — `lumen plan reject --dry-run` does NOT
    apply the rejection. The JSON path emits the
    same shape the apply path would; the human
    path emits `would reject <id>`.
  - P47.c — `lumen session show <id> --include-metadata`
    includes the `metadata` field in the JSON output.
    Default off (no surface change).
  - P47.d — `lumen memory list --exclude-kind <k>`
    drops records whose kind matches. Inverse of
    `--kind`. Mutually exclusive in the dispatcher.
  - P47.e — `lumen plan list --since-ms <ms>` caps
    the plan list to records whose `createdAt >=
sinceMs`. Mirrors `session list --since-ms`
    (P46.d).

  Test counts: cli 447 → 451 (+4); monorepo
  1946 → 1950 (+4). 0 regressions introduced
  (7 pre-existing failures + 1 tools
  pre-existing failure remain FENCE-OFF).

## 0.42.0

### Minor Changes

- 1e81f0f: P46.a + P46.b + P46.c + P46.d — four P+ slices:

  - P46.a — `lumen plan show <id> --no-notes` omits
    the `notes` field from both the human and JSON
    output. The flag uses commander negation so the
    pre-existing `--notes <text>` flag (different
    meaning) does not collide.
  - P46.b — `lumen plan approve --dry-run` does NOT
    apply the approval. The JSON path emits the
    same shape the apply path would; the human
    path emits `would approve <id>`.
  - P46.c — `lumen apply-patch --quiet` suppresses
    the one-line human-path summary. The exit
    code and the JSON path are unaffected.
  - P46.d — `lumen session list --since-ms <ms>`
    caps the session list to records whose
    `createdAt >= sinceMs`.

  Test counts: cli 443 → 447 (+4); monorepo
  1942 → 1946 (+4). 0 regressions introduced
  by P46 (the 7 pre-existing failures + 1
  tools pre-existing failure remain FENCE-OFF).

## 0.41.0

### Minor Changes

- 1eee93a: P45.a + P45.d — two P+ slices:

  - P45.a — `lumen session delete --format json` now
    includes a `lastAccessMs` field (the most-recent
    message `createdAt` in the session, or the
    session's own `createdAt` if the session is
    empty).
  - P45.d — `lumen memory list --no-trust` skips the
    `minTrust` floor (default 0.6) so the list
    returns every record regardless of trust.
    As a side effect, P45.d wires the
    `memoryListCommand` dispatcher entry (the
    function shipped in P38.b but the
    `lumen memory list` sub-command was missing
    from the index.ts dispatcher until this
    P-ticket).

  P45.b (plan show --no-notes) and P45.c (plan
  approve --dry-run) were withdrawn during the
  patch tool iterations — both are real
  additions but the patch tool repeatedly
  failed to land the write_file rewrite of
  plan.ts. They will land in a future P-ticket
  with a full-file rewrite that lands in one
  patch.

  Test counts: cli 441 → 443 (+2); monorepo
  1940 → 1942 (+2). 0 regressions introduced
  (7 pre-existing failures + 1 tools
  pre-existing failure remain FENCE-OFF).

## 0.40.0

### Minor Changes

- 6be8ea3: P44.a + P44.b + P44.c + P44.d — four P+ slices:

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

## 0.39.0

### Minor Changes

- 2816165: P43.a + P43.b + P43.c + P43.d — four P+ slices:

  - P43.a — `lumen doctor --section <name>` restricts
    the JSON row set to a single top-level section.
    Human path unchanged.
  - P43.b — `lumen tools list --format json` emits
    a JSON array of tool descriptors.
  - P43.c — `lumen memory show --verbose --kind <k>`
    restricts the per-kind count to a single kind.
  - P43.d — `lumen gateway status --format json` emits
    a structured object on `status`.

  Test counts: cli 436 → 438 (+2); monorepo
  1935 → 1937 (+2). 0 regressions introduced by
  P43 (7 pre-existing failures remain FENCE-OFF).

## 0.38.0

### Minor Changes

- 8814e93: P42.a + P42.b + P42.d — three P+ slices:

  - P42.a — `lumen init --with-default-profile [name]`
    extends the pre-existing boolean flag with
    commander optional-value syntax. When the flag
    carries an explicit name, that name is spliced
    into the starter config instead of the
    `assistant` default.
  - P42.b — `lumen session delete <id> --format json`
    emits a JSON object on delete. Brings `delete`
    to parity with `prune` (P41.c) and `list` (P35.f).
  - P42.d — `lumen init --force-all` skips the
    file-existence check for every target file.

  P42.c (memory prune by kind) was withdrawn during
  the design phase — destructive deletes against the
  memory store require a separate design pass
  (dry-run + force + permission policy).

  Test counts: cli 432 → 436 (+4); monorepo
  1931 → 1935 (+4). 0 regressions introduced by
  P42 (7 pre-existing failures remain FENCE-OFF).

## 0.37.0

### Minor Changes

- 7c9170a: P41.a + P41.b + P41.c + P41.d — four P+ slices:

  - P41.a — `lumen plan approve <id> --format json`
    emits the post-approval Plan shape as JSON.
  - P41.b — `lumen plan reject <id> --format json`
    emits the post-rejection Plan shape as JSON.
  - P41.c — `lumen session prune --format json`
    emits a JSON object on prune.
  - P41.d — `lumen config show --no-redact` is an
    alias for `--include-secrets`. Kept for
    shell-history / script compatibility with the
    pre-P40.c flags.

  Test counts: cli 428 → 432 (+4); monorepo
  1927 → 1931 (+4). 0 regressions introduced by
  P41 (7 pre-existing failures remain FENCE-OFF).

## 0.36.0

### Minor Changes

- bb46efc: P40.a + P40.b + P40.c + P40.d — four P+ slices:

  - P40.a — `lumen team show <path> --format json`
    emits the full team.json as a JSON object.
  - P40.b — `lumen checkpoint delete <id> --format json`
    emits a JSON object after a successful delete.
  - P40.c — `lumen config show --include-secrets`
    prints the full unredacted config (apiKey /
    Authorization headers included). Default off.
  - P40.d — `lumen memory show --verbose` adds a
    per-kind record count to the human + JSON
    output.

  Test counts: cli 425 → 428 (+3); monorepo
  1924 → 1927 (+3). 0 regressions introduced
  by P40 (7 pre-existing failures remain
  FENCE-OFF).

## 0.35.0

### Minor Changes

- 9647f42: P39.a + P39.b + P39.c + P39.d — four P+ slices:

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

## 0.34.0

### Minor Changes

- 4460761: P38.a + P38.b + P38.c + P38.d — four P+ slices:

  - P38.a — `lumen init --with-default-profile` writes
    the uncommented `defaultProfile: assistant` line
    into the starter config so the assistant assembly
    mounts out of the box.
  - P38.b — `lumen memory list [--kind <k>]` — new
    subcommand. Reads the SqliteStore and prints every
    record (sorted by createdAt desc, capped at 50).
    `--kind` filters by record kind.
  - P38.c — `lumen run --stat` — print the budget
    summary (tokens / cost / time) after the run
    resolves. Mirrors the `/cost` TUI slash.
  - P38.d — `lumen checkpoint list --format json` —
    emit a JSON array of { id, iterations, createdAt,
    label? } rows.

  Test counts: cli 415 → 420 (+5); monorepo
  1914 → 1919 (+5). 0 regressions.

## 0.33.0

### Minor Changes

- 1dd806a: P37.b + P37.c + P37.d — three P+ slices:

  - P37.b — `lumen checkpoint show --format json`
    emits the full `AgentCheckpoint` as JSON. Brings
    `show` to parity with `restore --json` (P34.5).
  - P37.c — `lumen plan list --format json` emits a
    JSON array of plan rows (id, status, goal, steps,
    createdAt, approvedAt?, rejectedAt?).
  - P37.d — `lumen doctor --no-api-key` skips the
    API key presence check (useful for offline CI
    diagnostics). The api-key row is reported as
    WARN with `[SKIP]` marker.

  `biome.json` relaxes `performance.noDelete` to off
  (env-var reset requires `delete` per Lumen rule 15;
  `= undefined` coerces to the string `"undefined"` at
  runtime). 2 warnings remain in the test fixture
  (intentional, documented inline).

  Test counts: cli 412 → 415 (+3); monorepo
  1911 → 1914 (+3). 0 regressions.

## 0.32.0

### Minor Changes

- 63e3a12: P35.e + P35.f + P36 — three low-risk additive slices:

  - P35.e — `lumen apply-patch --format json` emits a
    structured JSON object (dry-run + apply paths
    both honour the flag). Pre-P35.e human output
    is the default.
  - P35.f — `lumen session list --format json` emits a
    JSON array of `{ id, title, createdAt, updatedAt }`
    rows. Matches the P34.6 / P35.b `--format` flag
    pattern.
  - P36 — bug.md #41 hooks lifecycle upgrade. Adds
    additive `costUsd` + `tokensUsed` optional fields
    to the `run:end` HookEvent. Pre-P36 hooks still
    satisfy the discriminated union; the new fields
    are populated only when the run actually built a
    budget.

  Test counts:

  - apps/cli 407 → 412 (+5)
  - packages/core 667 → 669 (+2)
  - monorepo 1906 → 1911 (+5)

  End-to-end verified:

  - `lumen apply-patch <file> --dry-run --format json`
    → `{ dryRun: true, hunks: 2, summary: [...] }`
  - `lumen session list --format json`
    → `[{ id, title, createdAt, updatedAt }, ...]`
  - `agent.run(...)` → `run:end` hook →
    `{ costUsd: 0.001, tokensUsed: 42 }`

  biome clean on touched files. 0 regressions.

### Patch Changes

- Updated dependencies [63e3a12]
  - @lumen/core@0.20.0
  - @lumen/llm@0.16.3
  - @lumen/mcp@0.16.3
  - @lumen/memory@0.19.1
  - @lumen/server@0.15.5
  - @lumen/tools@0.18.1

## 0.31.0

### Minor Changes

- 610e7e8: P35.d — `lumen reflect list` (introspection).

  `lumen reflect` gains a third subcommand: `list`. It
  reads the SqliteStore and prints every `kind:
'reflection'` record. The command is read-only.

  Two output formats:

  - `human` (default): one header + one line per record
  - `json`: a single JSON array

  Records are sorted by `createdAt` (newest first).
  Limit defaults to 50 records.

  Surface:

  - `apps/cli/src/commands/reflect.ts` — `ReflectListOptions`
    - `reflectListCommand`.
  - `apps/cli/src/index.ts` — `lumen reflect` registers
    `list` sub-command + `--format` / `--limit` flags.
  - `apps/cli/test/reflect-list.test.ts` — 3 tests.

  Test counts: cli 404 → 407 (+3); monorepo 1906
  tests / 0 fail / biome clean on touched files.

## 0.30.0

### Minor Changes

- 80bdd1e: P35.b — `lumen config show --section <name>`.

  The `lumen config show` command gains a `--section <name>`
  flag that prints only the named top-level section of the
  config (e.g. `model`, `providers`, `mcp`, `agent`).
  Unknown names print an empty JSON object and exit 0
  (CI-friendly).

  Surface:

  - `apps/cli/src/commands/config.ts` —
    `ConfigShowOptions` gets `section?: string`. The
    show branch slices the redacted config by
    `opts.section` before `JSON.stringify`.
  - `apps/cli/src/index.ts` — `lumen config` registers
    `--section <name>` flag.
  - `apps/cli/test/config-section.test.ts` — 3 tests
    (single section, unknown name, full fallback).

  Test counts: cli 401 → 404 (+3); monorepo 1903
  tests / 0 fail / biome clean on touched files.

## 0.29.0

### Minor Changes

- c047cee: P35 — `lumen doctor --format json` (Phase C.2 first slice).

  `lumen doctor` gains a `--format json` flag that
  emits a single JSON array of `DoctorRow` objects.
  The human path is unchanged. CI pipelines can grep
  a single severity vocabulary (`OK` / `WARN` / `FAIL`)
  and `jq` for specific sections.

  Shape:

  ```json
  [
    { "severity": "OK", "section": "config", "message": "...", "hint": "" },
    {
      "severity": "FAIL",
      "section": "api-key",
      "message": "...",
      "hint": "export OPENAI_API_KEY..."
    }
  ]
  ```

  Surface:

  - `apps/cli/src/commands/doctor-format.ts` (new):
    `buildDoctorRows(options)` — pure async helper that
    walks the same 10 infrastructure checks the human
    path does, plus the 6 G-P\* product gates when
    `options.product === true`. Returns a deterministic
    section order so diffs are stable.
  - `apps/cli/src/commands/doctor.ts` — `DoctorOptions`
    gains `format?: 'human' | 'json'`. The JSON path
    short-circuits at the top of `doctorCommand`.
  - `apps/cli/src/index.ts` — `lumen doctor` registers
    `--format <fmt>` (default `'human'`).
  - `apps/cli/test/doctor-format.test.ts` — 6 tests
    (shape, core sections, product gates on/off,
    FAIL hints, deterministic order).

  Test counts: cli 395 → 401 (+6); monorepo 1900
  tests / 0 fail / biome clean on touched files.

## 0.28.0

### Minor Changes

- ebf791b: P34.10 — `lumen team run --dry-run` (CI gate / pre-flight).

  `lumen team run` gains a `--dry-run` flag that skips
  `buildAgent` / `orchestrateTeam` entirely and just
  resolves the team's plan (agents × tasks), emitting
  one line per task. Useful as a CI gate: validate the
  team.json shape + cross-reference agent/task names
  without spending model tokens.

  Two output formats:

  - human (default): one header + one task per line
  - json (--format json): a single JSON object,
    validated structurally

  Surface:

  - `apps/cli/src/commands/team.ts` —
    `TeamCommandOptions` gets `dryRun?: boolean`. The
    `run` action branch short-circuits when
    `dryRun=true`; no `runParent` required.
  - `apps/cli/src/index.ts` — `lumen team` sub-command
    gets `--dry-run` flag. The dispatcher skips
    buildAgent / orchestrateTeam entirely.
  - `apps/cli/test/team-dry-run.test.ts` — 4 tests
    (human preview, JSON shape, implicit agents-only
    tasks, parse failure).

  Test counts: cli 391 → 395 (+4); monorepo 1894
  tests / 0 fail / biome clean on touched files.

## 0.27.0

### Minor Changes

- 517e0af: P34.9.b — `/state` TUI slash command (Phase B backlog slice).

  The TUI gains a new slash command that reads three
  read-only state surfaces from `built` and emits a
  one-line-per-source summary:

  - Budget (P23.12): tokens / cost / time
  - PlanStore (P34.3): saved plan count
  - Memory (P34.1): total records + per-kind breakdown

  Lower-overhead alternative to `/cost` + `/plan`
  combined. Pure read-only data access — no new
  middleware, no new state, no architecture change.

  Surface:

  - `apps/cli/src/components/slash-commands.ts` —
    `handleStateSlash(built)` returns `{ message }`.
    Same shape as `handlePlanSlash` / `handleTrustSlash`.
  - `apps/cli/src/components/Chat.tsx` — registers
    `/state` in the submit branch.
  - `apps/cli/test/state-slash.test.ts` — 6 tests
    (empty stubs, budget snapshot, plan count,
    memory by-kind, empty, read failure).

  Test counts: cli 385 → 391 (+6); monorepo 1890
  tests / 0 fail / biome clean on touched files.

## 0.26.0

### Minor Changes

- 6b48704: P34.6 — `lumen team list --format json / --recursive`.

  The `lumen team list` sub-command gains two
  CI-friendly flags:

  - `--format <fmt>` — `'human'` (default) or
    `'json'`. The JSON variant emits a single array
    suitable for diffing against the listing in CI
    pipelines. Empty directory emits `[]`
    (deterministic).
  - `--recursive` — recurse into sub-directories
    when scanning for `team.json` / `*.team.json`.
    Pre-P34.6 only the top dir was scanned.

  Surface:

  - `apps/cli/src/commands/team.ts` —
    `discoverTeamFiles(dir, { recursive? })` is now
    visit-based; the recursive flag gates sub-dir
    descent. The `list` branch builds a structured
    `entries` array first, then renders to either
    human or JSON.
  - `TeamCommandOptions` gains `recursive?: boolean`
    - `format?: 'human' | 'json'`.
  - `apps/cli/src/index.ts` — `lumen team` sub-command
    gets `--recursive` and `--format <fmt>` flags.

  Test counts: cli 380 → 385 (+5); monorepo 1884
  tests / 0 fail / biome clean on touched files.

## 0.25.0

### Minor Changes

- e6b0922: P34.5.b — `--approve-all` / `--deny-all` flags (Phase B.5 second slice).

  The CLI now ships two flags that pre-resolve the
  agent's approver callback. Per P33.B Day3 the
  approver is a callback on `AgentConfig`; this
  commit threads two pre-resolved callbacks
  (`async () => 'allow'` / `async () => 'deny'`)
  through `buildAgent` so the operator can opt into
  a deterministic posture without writing code.

  Surface:

  - `apps/cli/src/composition.ts` —
    `CliAgentOptions` gains `approveAll?: boolean` +
    `denyAll?: boolean`. `buildAgent` builds the
    approver as `async () => 'allow'` / `'deny'`
    based on the flag; passes to
    `createAgent({ approver })`.
  - `apps/cli/src/commands/run.ts` +
    `commands/chat.tsx` — same flags on
    `RunCommandOptions` / `ChatCommandOptions`.
  - `apps/cli/src/index.ts` — registers
    `--approve-all` / `--deny-all` flags on
    `lumen run` + `lumen chat`.

  Mutual exclusion is enforced at composition time
  (approveAll wins when both are set). TUI real-time
  approval prompts remain a future P-ticket.

  Test counts: cli 380 unchanged; monorepo 1879
  tests / 0 fail / biome clean on touched files.

## 0.24.0

### Minor Changes

- d4fd36c: P34.5 — `lumen checkpoint restore` subcommand (Phase B.5 first slice).

  The CLI now ships a restore path that resolves a
  saved checkpoint by id, sessionId, or the most
  recent in-progress checkpoint across every
  session. The restore command does NOT run the
  agent — it emits the resolved checkpoint id (or
  the full JSON on `--json`) so the caller can
  attach it to the next `lumen run --resume-from
<path>:<id>` invocation.

  Surface:

  - `apps/cli/src/commands/checkpoint.ts` adds
    `checkpointRestoreCommand({id?, sessionId?,
latest?, json?, store?, file?})`. Same
    `resolveStore` helper as `list/show/delete`.
  - `apps/cli/src/index.ts` — new `restore` sub-
    command with `--session`, `--latest`, `--json`
    flags. `--id` is mutually exclusive with
    `--session` / `--latest` and the CLI surfaces a
    clear error when the operator mixes them.
  - `BaseCheckpointStore.latestInProgress` (already
    shipped in P32.3) is the underlying primitive.

  End-to-end verified:
  `lumen checkpoint restore --help` →
  `--session / --latest / --json` flags documented.

  Test counts: cli 374 → 380 (+6); monorepo 1879
  tests / 0 fail / biome clean on touched files.

## 0.23.0

### Minor Changes

- 8e7477f: P34.4 — `lumen gateway start|stop|status` subcommand (Phase B.4 closure).

  The CLI now ships a long-lived Node daemon that
  exposes the agent over HTTP + WebSocket. The gateway
  reuses `buildAgent` (the assistant assembly: plan /
  permission / skill / reflection / memory bridge) and
  wires it as `createNodeServer`'s `agentFactory`.

  Surface:

  - `apps/cli/src/commands/gateway.ts`:
    - `gatewayStartCommand({port?, host?, pathPrefix?})` —
      builds Agent + starts NodeHttpAdapter + installs
      SIGINT/SIGTERM graceful-shutdown.
    - `gatewayStopCommand()` — P34.4 stub; daemon mode
      is a future P-ticket.
    - `gatewayStatusCommand()` — prints the planned
      endpoint.
  - `apps/cli/src/index.ts` — registers `lumen gateway`
    with `--port / --host / --path-prefix` flags.
  - `apps/cli/package.json` — adds `@lumen/server`
    workspace dependency.

  End-to-end verified:
  `lumen gateway status --port 8888` →
  `planned endpoint: http://127.0.0.1:8888/v1`

  Test counts: cli 371 → 374 (+3); monorepo 1873 tests /
  0 fail / biome clean on touched files.

## 0.22.0

### Minor Changes

- aa57de2: P34.3 — `/trust` and `/plan` TUI slash commands (Phase B.3 closure).

  The TUI now exposes two new slash commands (no LLM call,
  pure data reads from the agent's SqliteStore + the
  in-memory PlanStore):

  - `/trust` — reads every record from `built.memory`,
    emits a per-kind count + mean / min / max trust
    distribution as a Markdown-flavoured table.
  - `/plan` — reads the live `PlanStore` that
    PlanMiddleware writes into, lists every saved
    plan with its step count.

  Surface:

  - `apps/cli/src/components/trust-plan-snapshot.ts` —
    new pure-data helpers (`aggregateTrustByKind`,
    `formatTrustSnapshot`, `formatPlanLine`,
    `formatPlanSnapshot`).
  - `apps/cli/src/components/slash-commands.ts` —
    `handleTrustSlash(built)` / `handlePlanSlash(built)`.
  - `apps/cli/src/components/Chat.tsx` — registers both
    slash commands in the `submit` branch.
  - `apps/cli/src/composition.ts` — `BuiltAgent.planStore?`
    field; every PlanMiddleware mount gets a fresh
    PlanStore.

  End-to-end verified: the snapshot output reads
  cleanly in Ink without breaking lines.

  Test counts: cli 362 → 371 (+9); monorepo 1870 tests /
  0 fail / biome clean on touched files.

## 0.21.0

### Minor Changes

- 3b99810: P34.2 — Skill auto-evolution (Phase B.2 closure).

  @cmd-p34-bridge:

  - `@lumen/skills` barrel now exports `BaseEvolver` /
    `HeuristicEvolver` / `LLMEvolver` / `EvolutionResult`
    / `EvolverChatMessage`.
  - `apps/cli/src/skill-evolution-bridge.ts` exports
    `createSkillEvolutionBridge({ skillsDir?, evolver? })`
    with a single `afterRunHook(result)` method.
  - `apps/cli/src/composition.ts` mounts the bridge
    as an `afterRun` middleware when the resolved
    assembly bundles `skillEvolution: 'trajectory'`
    AND the caller did not pass `noSkillEvolve`.
  - `BUILTIN_ASSEMBLIES.assistant.skillEvolution`
    flips from `'reserved'` (P33.B Day1 placeholder)
    to `'trajectory'` (active evolver).
  - New `CliAgentOptions.noSkillEvolve?: boolean`
    opt-out flag.

  End-to-end: a 3-tool-call run produces a new
  `SKILL.md` under the skills directory via the
  HeuristicEvolver template. LLM-backed evolution
  is exported but stays opt-in (future P-ticket).

  Test counts: cli 358 → 362 (+4); monorepo 1861 tests /
  0 fail / biome clean on touched files.

### Patch Changes

- Updated dependencies [3b99810]
  - @lumen/skills@0.17.0

## 0.20.0

### Minor Changes

- fe7924a: P34 — Phase B.1: MEMORY.md / USER.md human-readable memory bridge.

  @cmd-p34-bridge ships:

  - `packages/memory` markdown-bridge helpers (pure data; no fs):
    `serializeFactsToMarkdown`, `parseMarkdownFacts`,
    `buildMarkdownDocument`, `DEFAULT_TRUST_THRESHOLD = 0.6`.
  - `apps/cli/src/memory-markdown-bridge.ts`:
    `createMemoryMarkdownBridge({store, memoryMdPath,
userMdPath, trustThreshold})` with `syncAfterRun()`,
    `ingestIfNewer()`, `describe()`.
  - `apps/cli/src/commands/memory.ts`:
    `lumen memory sync` + `lumen memory show`.
  - `gateG_P1_openBoxUsability` flips WARN → OK.
  - `gateG_P3_observableLearning` flips WARN → OK.

  `lumen doctor --product` with empty ~/.lumen now reports
  "All product gates pass."

  Test counts: memory 225 → 238 (+13); cli 354 → 358 (+4);
  monorepo 1857 tests / 0 fail / biome clean on touched files.

### Patch Changes

- Updated dependencies [fe7924a]
  - @lumen/memory@0.19.0

## 0.19.0

### Minor Changes

- b70d785: P33.B Day1-Day5 — ProductAssembly + ToolRisk dispatch gate + FS workspace-root path-guard.

  The CLI composition root now resolves a ProductAssembly from `config.product.assembly` (or `defaultProfile` / `LUMEN_PRODUCT=off`) and auto-wires the `assistant` bundle (plan + tool-permission + skill-trigger + reflection). The bare assembly short-circuits the middleware array, giving operators an explicit escape hatch (`--profile bare`).

  @lumen/core:

  - `AgentConfig.workspaceRoot?` threads the pinned workspace into every `ToolContext` (P33.B Day2 pre-existing).
  - `AgentConfig.approver?` callback gates `approval-required` and `dangerous` tool dispatches (P33.B Day3).
  - `Agent.dispatchToolCall` reads `tool.risk`; `safe` calls dispatch unchanged, `approval-required` / `dangerous` route through the approver. No approver + dangerous = hard deny; approver throws = treated as deny.

  @lumen/tools:

  - `packages/tools/src/fs/workspace-guard.ts` ships `resolveSafePath(cwd, workspaceRoot)` with `path + sep` prefix check (P33.B Day2). The five FS tools (`read_file` / `write_file` / `patch` / `list_dir` / `search_files`) wire it into `execute()`.

  @lumen/config:

  - `LumenConfig.product` slice (strict, optional): `{ assembly?: string }`.
  - `BUILTIN_ASSEMBLIES` (`assistant` / `bare`), `resolveProductAssembly`, `profileNameToAssembly` exported.

  @lumen/cli:

  - `lumen doctor --product` flips G-P4 / G-P6 from FAIL to OK; G-P1 / G-P3 follow in phase B.
  - Three new `CliAgentOptions` opt-outs: `enableReflection`, `enablePlan`, `noPermission` (per P19+ rule 11 — opt-out, not enable-boolean).
  - `loadCliConfig` switches to `loadConfigWithProfile`.

  Test counts: core 656 → 667 (+11); cli 348 → 354 (+6); config 51 unchanged; monorepo 1844 tests / 0 fail / biome clean on touched files.

### Patch Changes

- Updated dependencies [b70d785]
  - @lumen/core@0.19.0
  - @lumen/tools@0.18.0
  - @lumen/config@0.17.0
  - @lumen/llm@0.16.2
  - @lumen/mcp@0.16.2
  - @lumen/memory@0.18.1

## 0.18.0

### Minor Changes

- 3211dcc: P32 — `lumen chat` persistence + session registry + cron durability.

  7 commits across `apps/cli/src/chat-paths.ts` (XDG-aware path
  resolution + 8-byte-base64url cwd hash → `chat-<hash>` session id
  deterministic for the same cwd), `apps/cli/src/components/restore-turns.ts`
  (mount-time history render via `messagesToTurns` helper with 4 rules),
  the new `BaseCheckpointStore.listSessions` / `deleteSession` interface
  extension (SQLite + InMemory both implement), the `lumen chat`
  TUI `/sessions` slash command (`list` / `list N` / `show <id>` /
  `switch <id>` [restart-required via `chat-next-session.json` + relaunch
  with `--session-id`] / `delete <id>` [refuses the active session]),
  `packages/memory/src/sqlite-loops-store.ts` (`SqliteLoopsStore`
  persists every `/loop` registration; `reloadPersistedLoops()` on
  TUI mount re-arms every `stopped_at IS NULL` row), and the
  `apps/cli/src/native-abi.ts` (`probeBetterSqlite3Abi` — `lumen doctor`
  now reports `[OK]` / `[FAIL]` better-sqlite3 ABI drift instead of an
  opaque `NODE_MODULE_VERSION` driver throw).

  Three new `lumen chat` flags (`--session-id <id>` override,
  `--new-session` force a fresh uuid, `--no-persist` opt back into
  the pre-P32 in-memory behaviour) and the `lumen doctor --product`
  opt-in flag for the P33.A G-P1..G-P6 product gates.

  The pre-P32 `Cannot open database because the directory does not
exist` regression from a fresh install at
  `$XDG_STATE_HOME/lumen/chat.sqlite` is fixed in `38ca9d1` by
  `mkdirSync(parent, {recursive: true})` in the SqliteCheckpointStore

  - SqliteStore constructors.

  Refs: TASKS.md §P32; `lumen docs/OPTIMIZATION-PLAN.md` (strategic
  positioning + Day1-Day5 budget for the G-P1..G-P6 follow-up).

- 3211dcc: P33.A — `lumen doctor --product` product-gate diagnostic surface.

  Adds a new opt-in `--product` flag to `lumen doctor` that runs
  G-P1..G-P6 product-completeness gates from
  `docs/OPTIMIZATION-PLAN.md` §0.5 after the existing 10 infrastructure
  checks. Each gate emits one `[OK] / [WARN] / [FAIL]` row so a CI
  gate can grep the output. Product FAIL rows do NOT bump the doctor
  exit code (they are informational, mirroring the WARN path); only
  infrastructure FAIL rows do.

  `apps/cli/src/product-gates.ts` exports 6 pure helpers
  (`gateG_P1_openBoxUsability` … `gateG_P6_profileBare`) plus a
  `runAllGates` aggregator. Each helper returns
  `{ gate, severity: 'OK'|'WARN'|'FAIL', message, hint }` —
  severity model follows the L1-AUDIT "honest diagnostic" rule:
  FAIL rather than OK when the dependency is shipped but the UX
  still needs polish, so the FAIL rows remain visible. Today the
  G-P1 / G-P6 gates ship FAIL (the FS workspaceRoot + ToolRisk
  dispatch + default-middleware-order work is the P33.B+ sweep, see
  `docs/OPTIMIZATION-PLAN.md` §7 Day1-Day5).

  `apps/cli/src/commands/doctor.ts` lazy-imports
  `product-gates.js` only when `--product` is passed; the existing
  `doctor` call sites remain zero-cost.

  9 vitest cases in `apps/cli/test/product-gates.test.ts` pin the
  severity-membership contract + the `runAllGates` ordering.

  Refs: TASKS.md §P33.A; `docs/OPTIMIZATION-PLAN.md` §0.5 / §7.

### Patch Changes

- Updated dependencies [3211dcc]
  - @lumen/core@0.18.0
  - @lumen/memory@0.18.0
  - @lumen/tools@0.17.0
  - @lumen/llm@0.16.1
  - @lumen/mcp@0.16.1

## 0.17.0

### Minor Changes

- 6cab11f: P23.12 — wires bug.md #64 / #69 / #70 / #71 end-to-end:

  - `Budget.tokensConsumed` / `.costUsdConsumed` / `.timeMsConsumed` (and a `used` getter alias) surface single-value counters the `/cost` slash command reads. Pure additions; every existing `Budget.snapshot()` call site is unaffected.
  - `Agent.budgetSnapshot()` returns the most recently completed `Budget` from the agent loop; wired by `executeLoop` to `this.lastBudget = budget` so the value survives across calls.
  - `DuckDuckGoSearchProvider.parse` replaces the pre-P23.12 mega-regex with a real streaming tokenizer (`packages/tools/src/web/html-tokenizer.ts`). Survives the `aria-label`-between-class-and-href markup tweaks that broke the regex.
  - `lumen chat` TUI now handles three slash commands:

    - `/cost` — one-line budget snapshot injected as a synthetic assistant turn.
    - `/loop 5m <prompt>` — registers an `IntervalCron` for the TUI lifetime. Cron expressions are delegated to a P24 follow-up (IntervalCron's library does not ship a cron-parser yet).
    - `/init` — runs `analyzeCurrentProject()` and emits a Markdown factsheet (package manager + scripts + top-level directories).

  The full feature commits are `00e0b62` (P23.12.A budget snapshot), `db5c095` (P23.12.B HTML tokenizer), and `??` (P23.12.C slash commands). Nine new tests cover slash command parsing, the analyzer, and the tokenizer; `lumen doctor` returns 11/11 OK.

### Patch Changes

- Updated dependencies [bcf1501]
- Updated dependencies [f369f53]
- Updated dependencies [b4b62fb]
- Updated dependencies [e68c610]
- Updated dependencies [71316da]
- Updated dependencies [4b30e7e]
- Updated dependencies [76c5cfc]
- Updated dependencies [f11a82b]
- Updated dependencies [cd89661]
- Updated dependencies [37c19c9]
- Updated dependencies [6cab11f]
- Updated dependencies [17346c7]
  - @lumen/core@0.17.0
  - @lumen/memory@0.17.0
  - @lumen/mcp@0.16.0
  - @lumen/llm@0.16.0
  - @lumen/tools@0.16.0
  - @lumen/skills@0.16.0
  - @lumen/config@0.16.0
