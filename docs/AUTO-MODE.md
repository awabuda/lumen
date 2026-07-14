# Lumen auto-mode (P22.5)

> **Operator guide.** The P22.5 auto-mode layer sits between
> the static permission policy (P22.0) and the interrupt
> middleware (P20.1). It is **opt-in**: enabled only when the
> policy file declares `autoMode: { enabled: true, ... }`.
> This guide explains what auto-mode is, what it is not, and
> the three worked examples that ship with `lumen init`.

## 0. What is auto-mode

- **Static permission** (P22.0) answers "is this tool on the
  allow-list?" — deterministic, no LLM, three outcomes.
- **Auto-mode** (P22.5) answers "for a tool the static layer
  said `ask`, is this call obviously low-risk enough to
  auto-allow?" — deterministic, **no LLM**, heuristic.
- **Interrupt** (P20.1) answers "should the operator
  approve this call?" — async, callback-driven.

The three layers compose in this order:

```
tool-permission → tool-permission-auto → interrupt → skill-trigger → plan
```

(`name` is sorted alphabetically; the order falls out of the
middleware contract.)

When the static layer says `allow` or `deny`, auto-mode does
not run. When the static layer says `ask`, auto-mode's
heuristic engine decides:

- `allow` — dispatch without consulting the operator
  (short-circuits the interrupt layer; the only place
  in P22.x where an inner gate is bypassed)
- `ask` — fall through to the interrupt layer
- `deny` — throw a typed `AbortError`; P20.4.2 catches it
  and auto-saves a checkpoint

## 1. Quick start

```bash
# 1. Write a starter policy file at ~/.lumen/permissions.yaml.
lumen init

# 2. Edit the file to enable auto-mode (default is OFF).
# Add an autoMode block at the bottom:
#
#   autoMode:
#     enabled: true
#     neverAllowTools: [terminal]    # even low-risk calls do not auto-allow
#     hardDenyPatterns: []            # optional regex deny list
#
# 3. Run an agent with the policy in effect.
lumen run --permissions ~/.lumen/permissions.yaml "summarise README.md"

# 4. Inspect the resolved policy, including the auto-mode block.
lumen permissions show
```

The starter file from `lumen init` does **not** enable
auto-mode by default. Operators opt in explicitly.

## 2. Auto-mode block shape

```yaml
version: 1
default: ask

rules:
  - name: allow-read-file
    tools: [read_file]
    decision: allow

  - name: allow-list-dir
    tools: [list_dir]
    decision: allow

  - name: deny-terminal
    tools: [terminal]
    decision: deny

autoMode:
  enabled: true
  neverAllowTools: [terminal]
  hardDenyPatterns: ['^write_file$']
  allowPatterns: ['low-risk read-only tools']
  softDenyPatterns: []
```

- `enabled` must be `true` for the heuristic engine to
  fire. When `false` (the default), every call goes
  through the static layer + interrupt chain unchanged.
- `neverAllowTools` is a hard opt-out: even a low-risk
  tool listed here is never auto-allowed. The interrupt
  layer decides instead.
- `hardDenyPatterns` is a list of regex patterns. If a
  tool name matches any pattern, the call is `deny`
  (throws a typed `AbortError`). Malformed regex
  patterns are skipped silently — they are operator
  typos, not runtime crashes.
- `allowPatterns` and `softDenyPatterns` are plain-text
  audit-only fields. The heuristic engine does **not**
  interpret them. They live in the policy file for the
  operator's reference and to make the intent of the
  rule list explicit.

## 3. Risk table (core-shipped)

| Tool name | Default tier | Auto-allowed? |
| --- | --- | --- |
| `read_file` | `low` | yes (unless `neverAllowTools`) |
| `list_dir` | `low` | yes |
| `search_files` | `low` | yes |
| `write_file` | `medium` | yes (unless `neverAllowTools`) |
| `terminal` | `high` | **no** — always `ask` |
| anything else | `unknown` | **no** — always `ask` |

The risk table is **core-shipped**, not policy-shipped. The
rationale: a malicious repo cannot weaken the default risk
tier by adding a permissive rule. Claude Code makes the
same design decision for its `autoMode` setting (read from
user settings + `--settings` + managed, ignored in project
settings — see `docs/P22.5-DESIGN.md` §0.1).

## 4. Decision precedence

For a tool call that the static layer returned `ask` for:

1. `hardDenyPatterns` matches the tool name → **deny**
2. `neverAllowTools` contains the tool name → **ask**
   (interrupt layer decides; the operator explicitly
   opted this tool out of auto-allow)
3. tier is `high` or `unknown` → **ask**
4. tier is `low` or `medium` → **allow** (short-circuit the
   interrupt layer)

When `autoMode.enabled` is `false`, every call returns
`ask` regardless of tier. This is the
"auto-mode-is-off" default.

## 5. Audit

Every auto-mode decision lands in the middleware's
`AutoModeState.decisions` slice:

```ts
interface AutoModeDecisionRecord {
  toolName: string
  tier: 'low' | 'medium' | 'high' | 'unknown'
  decision: 'allow' | 'ask' | 'deny'
  at: number
}
```

The CLI surfaces decisions through the checkpoint system
(when the run uses `--checkpoint`); the decision log lands
in the same checkpoint blob as the run. P22.6 (cross-policy
imports) is the next slot for a dedicated
`lumen permissions audit` subcommand.

## 6. Worked examples

### 6.1 Read-only workflow

A team that only needs the agent to read files:

```yaml
version: 1
default: ask

rules:
  - name: allow-read-only
    tools: [read_file, list_dir, search_files]
    decision: allow

autoMode:
  enabled: true
  neverAllowTools: [write_file, terminal]
  hardDenyPatterns: []
  allowPatterns: [low-risk read-only]
  softDenyPatterns: []
```

Result: the static layer allows the read tools; the
auto-mode never allows `write_file` or `terminal`; the
interrupt layer never fires for the read tools.

### 6.2 CI pipeline

CI should default to `deny` and only allow the exact
tools the pipeline needs. The auto-mode block then
auto-allowances the low-risk subset.

```yaml
version: 1
default: deny

rules:
  - name: allow-build-tools
    tools: [read_file, list_dir, search_files, terminal]
    decision: allow

autoMode:
  enabled: true
  neverAllowTools: [terminal]
  hardDenyPatterns: ['\\.env$']  # deny any tool whose name ends in .env
  allowPatterns: [CI read-only]
  softDenyPatterns: []
```

Result: a `read_file` call passes the static layer (allowed)
and the auto-mode (low risk). A `terminal` call is allowed
by the static layer but never-allowed by auto-mode, so it
falls through to the interrupt layer (which the CI
`--approve-on` flag will auto-allow). A tool name ending
in `.env` is hard-denied by auto-mode.

### 6.3 Dev sandbox

A developer who wants auto-mode to handle most calls but
keep an eye on the agent:

```yaml
version: 1
default: ask

rules:
  - name: allow-read-only
    tools: [read_file, list_dir, search_files]
    decision: allow

  - name: allow-write-tmp
    tools: [write_file]
    decision: allow
    when:
      argMatches:
        path: ^/tmp/

  - name: deny-terminal
    tools: [terminal]
    decision: deny

autoMode:
  enabled: true
  neverAllowTools: [terminal]
  hardDenyPatterns: []
  allowPatterns: [low-risk read; tmp writes]
  softDenyPatterns: [writes outside /tmp]
```

Result: read tools auto-allow; `write_file` to `/tmp/`
auto-allows (medium tier, never-allow list is empty for
write_file); `write_file` outside `/tmp/` falls through
to the interrupt layer where the operator can review.

## 7. CLI surface

```bash
# Edit the policy file (default location).
lumen init [--force] [--path <file>]
$EDITOR ~/.lumen/permissions.yaml   # add the autoMode block

# Print the resolved policy, including the auto-mode section.
lumen permissions show [--path <file>] [--json]

# Use the policy in a run / chat.
lumen run --permissions <path> [prompt]
lumen chat --permissions <path>
```

The `--auto-mode` flag is a convenience that surfaces the
operator's intent: it is a no-op when the policy file's
`autoMode.enabled` is `true`, and it prints a hint when it
is `false` (use `lumen init` to bootstrap). See
`docs/P22.5-DESIGN.md` §2.5.3 for the rationale.

## 8. Composition with the interrupt layer

When the auto-mode classifier returns `allow`, the call
dispatches and the interrupt layer is bypassed. This is the
**one place in P22.x where an inner gate is bypassed**, and
it is by explicit operator opt-in. The rationale: enabling
auto-mode means "auto-allow low-risk calls"; the interrupt
layer would defeat the purpose. P22.0's `allow` decision
is different — the static layer's allow does not bypass
the interrupt chain.

When the auto-mode classifier returns `ask`, the call
falls through to the interrupt layer unchanged. The
interrupt layer's rules (`--interrupt-on` + `--approve-on`)
still apply.

## 9. Limits

- `autoMode: { enabled: true }` is the only opt-in signal.
  There is no `--auto-mode` flag that overrides the policy
  file; the file is the source of truth.
- The risk table is core-shipped, not policy-shipped. To
  override a tool's tier, edit `DEFAULT_RISK_TABLE` in
  `packages/core/src/agent/middleware/auto-mode.ts`.
  P22.7 (LLM classifier) is the right slot for per-tool
  prose overrides.
- No cross-policy imports. One file per run. Multi-file
  composition is P22.6 (deferred).
- The `lumen permissions audit` subcommand is P22.6. For
  now, decisions land in the middleware's state slice and
  can be inspected via the checkpoint system.
