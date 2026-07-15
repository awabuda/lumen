# Lumen tool permissions (P22)

> **Operator guide.** The P22 permission policy file is a static,
> deterministic YAML rule list that gates tool calls before the
> interrupt middleware (P20.1) sees them. This guide explains
> the policy file, walks through three worked examples, and
> shows the CLI surface.

## 0. Why a static policy file

- **Deterministic**: every decision is reproducible from the file
  content + the tool call. No LLM, no fuzzy matching, no
  classifier. A `git log` of the policy file is the audit log.
- **Auditable**: operators can read the policy and reason about
  exactly what the agent can do. The `lumen permissions show`
  command prints the resolved policy in human-readable form.
- **Composes with P20.1**: the three-way decision
  (`allow` / `deny` / `ask`) sits in front of the interrupt
  chain. `ask` falls through to `createInterruptMiddleware`,
  which can prompt the operator (the `--approve-on` flag) or
  abort the run. `allow` records the decision and lets the
  inner interrupt chain decide.
- **Per-deploy**: one file per project / per host. Set
  `LUMEN_PERMISSIONS_PATH` or pass `--permissions <path>` to
  point `lumen run` / `lumen chat` at a project-specific file.

## 1. Quick start

```bash
# 1. Write a starter policy file at ~/.lumen/permissions.yaml.
lumen init

# 2. Inspect the resolved policy.
lumen permissions show

# 3. Run an agent with the policy in effect.
lumen run --permissions ~/.lumen/permissions.yaml "summarise README.md"

# Or use the chat TUI.
lumen chat --permissions ~/.lumen/permissions.yaml
```

The starter file (from `lumen init`) ships with a least-privilege
default: `default: ask`, three read tools allowed, terminal
denied. See `apps/cli/src/commands/init.ts` for the exact text.

## 2. Policy file shape

```yaml
version: 1            # schema version; bump on shape changes
default: ask          # what to do when no rule matches the tool name

rules:                # ordered list; first match wins
  - name: allow-read-md        # human-readable label; surfaced in audit
    tools: [read_file]         # tool names this rule matches
    decision: allow            # allow | deny | ask
    when:                      # optional: match on argument values
      argMatches:
        path: \.md$            # regex; only applies to read_file calls
                               # whose `path` argument ends in `.md`

  - name: deny-shell
    tools: [terminal]
    decision: deny
```

- `version` must be the literal `1`. Future schema bumps will
  increase this and the loader will reject old files.
- `default` is the policy-level default. `ask` is the safe
  baseline; `allow` is the permissive default. Operators opt
  into `allow` only after reviewing the rule list.
- `rules` is an ordered list. **First match wins.** A later
  rule with the same tool name is shadowed. Order rules
  most-specific first.
- `name` is surfaced in the deny error message and the audit
  state slice. Use descriptive names (`allow-read-md`,
  `deny-terminal-rm-rf`) so the operator can scan the file.
- `tools` is the list of exact tool names the rule applies to.
  No glob support in P22.0; a `*` matcher is P22.5+ (deferred).
- `decision` is one of `allow`, `deny`, `ask`.
- `when.argMatches` is an optional map of `argKey -> regex
  string`. The rule fires only when **every** entry matches.
  Number / boolean / object args are JSON-stringified before
  regex matching (so the rule survives structured args).

## 3. Three outcomes

| Decision | Runtime effect | Audit |
| --- | --- | --- |
| `allow` | The call dispatches via `defaultCall()`. The remaining middleware (notably the interrupt chain) still runs. | `PermissionState.decisions` records `{toolName, decision: 'allow'}` |
| `deny` | Throws `AbortError('permission denied: tool "<name>"')`. The P20.4.2 catch path auto-saves a checkpoint and re-throws. The run aborts. | `PermissionState.decisions` records `{toolName, decision: 'deny'}` |
| `ask` | Falls through to `defaultCall()`. The interrupt middleware decides. With `--approve-on <name>`, the tool always dispatches. With just `--interrupt-on <name>`, the call aborts unless an `approve` callback returns `true`. | `PermissionState.decisions` records `{toolName, decision: 'ask'}` |

`deny` is the only decision that **always** aborts. `ask` and
`allow` are the same as far as the permission layer is
concerned; the difference is in the audit log and the
operator's mental model.

## 4. Worked examples

### 4.1 Single developer on a local machine

A permissive policy that auto-approves the common read tools
and asks on the rest:

```yaml
version: 1
default: ask

rules:
  - name: allow-read-only
    tools: [read_file, list_dir, search_files]
    decision: allow

  - name: allow-write-on-home
    tools: [write_file]
    decision: allow
    when:
      argMatches:
        path: ^(/Users/|/home/)
```

The `allow-write-on-home` rule fires only when the `path`
starts with a home directory. Writes elsewhere fall through to
the default `ask` and then to the interrupt chain.

### 4.2 CI pipeline

CI should default to `deny` and only allow the exact tools the
pipeline needs. The pipeline can also pass
`--no-memory --no-mcp` so the agent has no other attack
surface.

```yaml
version: 1
default: deny

rules:
  - name: allow-build-tools
    tools: [read_file, list_dir, search_files, terminal]
    decision: allow
```

With this policy, the agent has no write access and cannot
touch any tool outside the allow-list. A `write_file` attempt
aborts the run with `permission denied: tool "write_file"`.

### 4.3 Security-paranoid enterprise

A deny-by-default policy with a small allow-list and explicit
asks for the rest. Combine with `--interrupt-on terminal` so
terminal calls also need operator approval.

```yaml
version: 1
default: deny

rules:
  - name: allow-read-only
    tools: [read_file, list_dir, search_files]
    decision: allow

  - name: allow-read-md-only
    tools: [read_file]
    decision: allow
    when:
      argMatches:
        path: \.md$
    # (Note: the previous rule already allowed all read_file
    # calls. The when branch is for explicit, scoped allows.
    # Order matters; the more-specific rule should come first.)

  - name: ask-shell
    tools: [terminal]
    decision: ask
```

Note the `ask` decision: the permission layer does not abort,
but the interrupt layer (wired via `--interrupt-on terminal`)
**does** abort unless the operator pre-approves the call with
`--approve-on terminal`. The two layers compose.

## 5. CLI surface

```bash
# Write a starter policy file.
lumen init [--force] [--path <file>]

# Print the resolved policy.
lumen permissions show [--path <file>] [--json]

# Use the policy in a run / chat.
lumen run --permissions <path> [prompt]
lumen chat --permissions <path>

# Override the default path.
LUMEN_PERMISSIONS_PATH=/etc/lumen/permissions.yaml lumen run "..."

# Validate the file at composition time (typos fail fast).
# A missing file → typed ConfigError; a malformed file → typed
# ConfigError with the Zod issue list.
```

## 6. Composition with the interrupt layer

The permission middleware's `name` is `'tool-permission'`,
and the interrupt middleware's `name` is `'interrupt'`. The
CLI composition sorts middleware by `name`, so the order is:

```
tool-permission → interrupt → skill-trigger → plan
```

Concretely:

1. Tool call is about to dispatch.
2. `tool-permission` evaluates the policy:
   - `deny` → throw; abort.
   - `allow` or `ask` → call `defaultCall()`.
3. The `interrupt` middleware sees the call (if wired):
   - If the tool is in `interruptOn`, fires the `approve`
     callback or aborts.
4. The actual tool dispatch.

This is a deny-only gate for `deny` and a transparent pass-through
for `allow` / `ask`. P22.5 (auto-mode) is the place to revisit
the chain-skipping design; in P22.0 the inner interrupt chain
always runs on `allow`.

## 7. Audit

The `PermissionState` slice is exposed via the middleware
contract. The CLI surfaces decisions through:

```bash
# Run with the policy and a checkpoint database.
lumen run --permissions <policy> --checkpoint <db> "..."

# Inspect the latest checkpoint's decision log.
lumen checkpoint show --db <db> --latest
```

(Decision-log wiring is P22.5+; P22.0 records decisions in
memory and the audit-row rendering is left to the host
application. The CLI ships `lumen permissions audit` since
P22.6.3 — see [§8 Cross-policy imports](#8-cross-policy-imports-p226)
for the operator guide.)

## 8. Cross-policy imports (P22.6)

> **Operator guide.** A policy file can pull in additional
> files via the `imports:` block. The loader walks the imports
> in order, merges the imported files' `rules`, `autoMode`,
> `neverAllowTools`, `hardDenyPatterns`, `allowPatterns`,
> and `softDenyPatterns` onto the root policy. The root
> policy's `default` and `version` always win. Cyclic imports
> are a typed `ConfigError`. The composition root reads a
> single path; cross-file composition lives in the file
> itself, not on the CLI flag.

### 7.1 A starter multi-file project

```yaml
# ~/.lumen/permissions.yaml
version: 1
default: ask
rules:
  - name: deny-terminal
    tools: [terminal]
    decision: deny
imports:
  - ./shared/personal.yaml
  - ./shared/team.yaml
```

```yaml
# ./shared/personal.yaml
version: 1
default: ask
rules:
  - name: allow-read
    tools: [read_file, list_dir]
    decision: allow
```

```yaml
# ./shared/team.yaml
version: 1
default: ask
rules:
  - name: allow-write
    tools: [write_file]
    decision: ask
  - name: deny-publish
    tools: [publish, deploy]
    decision: deny
autoMode:
  enabled: true
  neverAllowTools: [terminal]
  hardDenyPatterns: ['^publish$', '^deploy$']
```

The merged policy is the root's `deny-terminal` plus the two
imports' rules in declaration order: `deny-terminal`,
`allow-read`, `allow-write`, `deny-publish`. The autoMode
block is the last import that declares one — here, `team.yaml`.

### 7.2 Cycle detection

```yaml
# root.yaml
imports: [./child.yaml]
# child.yaml
imports: [./root.yaml]
```

`lumen permissions show` on `root.yaml` throws:

```
ConfigError: circular policy import: /home/me/root.yaml (already visited in this composition)
```

The loader tracks a `Set<string>` of absolute paths and
rejects a revisit.

### 7.3 Managed-only lockout (P22.6.1)

The root file's `allowOverrides: false` (the default) makes
the root's denies win over any import that tries to allow
the same `name`:

```yaml
# root.yaml
version: 1
default: ask
rules:
  - name: deny-terminal
    tools: [terminal]
    decision: deny
imports:
  - ./overrides.yaml
```

```yaml
# overrides.yaml
version: 1
default: ask
rules:
  - name: deny-terminal
    tools: [terminal]
    decision: allow  # dropped: root's deny wins
```

The merged `rules` list keeps the root's `deny-terminal` (deny)
and drops the import's `deny-terminal` (allow). Set
`allowOverrides: true` in the root to opt out (last-import-wins;
discouraged for production).

### 7.4 Source attribution (P22.6.2)

`lumen permissions show` annotates every rule with the file
it came from:

```
policy: /home/me/.lumen/permissions.yaml
version: 1
default: ask
rules:
  - deny-terminal (from /home/me/.lumen/permissions.yaml)
    tools: [terminal]
    decision: deny
  - allow-read (from /home/me/shared/personal.yaml)
    tools: [read_file, list_dir]
    decision: allow
```

The JSON form (`--json`) carries a `_sources` map (rule
name → source file path) for audit pipelines.

### 7.5 The audit log (P22.6.3)

`lumen permissions audit [--format human|json|csv]` walks the
policy and prints one row per rule with a SHA-256 of the
source file:

```
$ lumen permissions audit --format csv
rule,tools,decision,source,sourceHash
deny-terminal,terminal,deny,/home/me/.lumen/permissions.yaml,3a7c...
allow-read,read_file|list_dir,allow,/home/me/shared/personal.yaml,9b1e...
```

The JSON form (`--format json`) is a `PermissionsAuditReport`:

```json
{
  "policy": "/home/me/.lumen/permissions.yaml",
  "generatedAt": "2026-07-15T13:00:00.000Z",
  "entries": [
    { "rule": "deny-terminal", "tools": ["terminal"], "decision": "deny",
      "source": "/home/me/.lumen/permissions.yaml", "sourceHash": "3a7c..." }
  ]
}
```

Pin the audit log to a specific revision with
`git checkout <sha> -- <policy>` and re-run the audit. The
hashes will match only if no rule was added or removed.

## 9. Limits

- Max rules per policy file: 1000 (`PERMISSION_MAX_RULES`).
  Beyond that the loader throws; a real project should split
  into multiple files (P22.6).
- No glob support. Exact tool names only.
- No LLM-based classification. Every decision is reproducible
  from the policy file + the tool call.
- Multi-file composition is via the in-file `imports:` block
  (P22.6); the loader does not accept multiple `--permissions`
  flags.
