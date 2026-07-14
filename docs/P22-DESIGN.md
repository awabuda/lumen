# P22 design lock — Permission modes for HITL tool dispatch

> **Design-only pass.** P22 picks the highest-value candidate from the
> P21 backlog (TASKS line 977–988). P19+ rule 16 mandates a 4-framework
> real-URL fetch + 6-question audit + decision-list gate before any
> code lands. The choice, the framework comparison, and the design
> constraints are all locked here. The first P22.x implementation
> commit is the next step.

## 0. Why P22 is permission modes

### 0.1 4-framework fetch verification (2026-07-13)

| Framework | URL fetched on 2026-07-13 | Key takeaway for P22 |
| --- | --- | --- |
| **LangGraph 1.0** | `https://docs.langchain.com/oss/python/langgraph/interrupts` and `https://docs.langchain.com/oss/python/langgraph/add-human-in-the-loop` (re-fetched 2026-07-13) | `interrupt()` is a checkpoint-pausing call that can be placed anywhere in a graph node. The graph saves state via the checkpointer and waits indefinitely; the caller resumes by invoking the graph again with `Command(resume=...)`. **Dynamic**, not config-driven: a node calls `interrupt('Do you approve?')` and gets back the user's response when the graph resumes. The contract is: pause anywhere, persist, resume from the same node. |
| **Claude Code** | `https://docs.claude.com/en/docs/claude-code/iam` and `https://docs.claude.com/en/docs/claude-code/settings` (re-fetched 2026-07-13) | `permissions.allow` / `permissions.deny` arrays, with `pathPattern` / `git:` / `github:` / `npm` / `file` source types. **Config-driven**, evaluated on every tool call, plus an `autoAllowBashIfSandboxed` toggle for enterprise sandboxes. The pattern is: declarative policy file + match-on-each-dispatch. |
| **OpenClaw** | `https://openclaw.ai/blog` (re-fetched 2026-07-13). The 2026-05-31 "Safer Than YOLO" post is the closest public surface for permission modes. | Three-layer exec guardrail: **policy first → review low-risk misses → human-in-the-loop for the rest**. Opt-in auto mode for Enterprise deployments. Configuration lives at `~/.openclaw/openclaw.json` (allowFrom lists, mention rules, group policies). The shape is config + classifier + queue, not middleware. |
| **Hermes Agent** | `https://hermes-agent.nousresearch.com/docs/` (re-fetched 2026-07-13) | Top-level nav lists `Security > Command approval, authorization, container isolation` as a sidebar entry, but the destination page returns 404. **Hermes public docs are not verifiable for permission modes** at the link level. The fact that the nav item exists is what we cite; the behavior claim is **unverified** for P22 purposes. The same caveat landed in `docs/p19.5-meta-reflector-design-basis.md` §2.3 for "OpenClaw daily→long-term distillation" and in `docs/P21-DESIGN.md` §0.1. |

**Synthesis**: two distinct shapes. **LangGraph is runtime-driven**: an explicit `interrupt()` call pauses the graph and waits for a typed human response. **Claude Code / OpenClaw are config-driven**: a static policy file is evaluated on each call, with opt-in human escalation. They solve the same problem differently, and the choice is real. Hermes surface is unverified.

### 0.2 6-question audit (P19+ rule 10 re-run for P22)

| # | Question | Lumen status (post-P21) | Gap? |
| --- | --- | --- | --- |
| 1 | Skill | `SkillRegistry` + `KeywordTrigger` + `createSkillTriggerMiddleware` (P20.6) | full |
| 2 | Team | `createSequentialSubAgent` / `createParallelSubAgent` / `createHandoffSubAgent` / `createSupervisorSubAgent` (P19.3/4) + `teamCommand` orchestrator (P20.7) | full |
| 3 | Workspace | `BaseCheckpointStore` + `InMemoryCheckpointStore` + `SqliteCheckpointStore` (P20.4) + `runWithHeartbeat` (P20.2 / P21.2) | full |
| 4 | Context | `BaseMemoryStore` + `SqliteStore` + `BaseVectorMemoryStore` (P6/P9) | full |
| 5 | Failure | `Agent.run` step-level durable checkpoint + `latestInProgress` resume (P21.0/P21.1) + `findResumeCheckpoint` 10-min TTL (P21.1) | full |
| 6 | Security | `createInterruptMiddleware` with declarative `toolNames` / `maxIterations` / `onError` rules + new `approve` callback (P20.1.1 / P20.1.2 follow-up) | **partial** — see below |

The Security axis is the only gap. P20.1.1 already shipped a **declarative interrupt** middleware with three rule types: `toolNames` (match by name), `maxIterations` (per-run iteration cap), `onError` (any tool error aborts). The P20.1.2 follow-up added an optional async `approve(toolCall, ctx)` callback so the host application can ask the user. The CLI exposes `--interrupt-on` and `--approve-on` flags. **What is missing** is the **policy-shaped** surface that LangGraph / Claude Code / OpenClaw also offer: a static file (e.g. `~/.lumen/permissions.yaml`) that maps tool-name or argument patterns to allow / deny / ask policies, evaluated on every dispatch, independent of the host application.

P22 closes that gap.

### 0.3 Why P22 is the right slot (not P23+)

- P21 (durable execution) is shipped. The next surface to land is **not** observability (P20.8/10 already cover LangSmith-style), and is **not** multi-agent (P19.3/4 + P20.7 already cover deepagents). It is **policy** — the only "framework-level capability we don't have" axis left.
- P22 picks **permission modes** over computer-use, long-term-memory, and audio because permission modes are the **only** candidate that:
  1. **Aligns with a shipped P20.1 surface** (lumen already has the interrupt middleware; permission modes are the static-policy sibling).
  2. **Has the clearest 4-framework precedent** (LangGraph interrupt, Claude Code permission rules, OpenClaw auto-mode approvals).
  3. **Can ship as pure data + a thin dispatcher** — no native GUI, no audio stack, no model-context host.

## 1. P22 core definition

P22 adds a **declarative permission layer** that sits in front of `createInterruptMiddleware` and decides, on every tool call, whether the call should:

- `allow` — dispatch without consulting the host.
- `deny` — reject with a typed `AbortError` and `outcome: 'denied'`. No checkpoint needed (deterministic refusal).
- `ask` — fall through to the existing `createInterruptMiddleware` path; the host's `approve` callback decides.

The policy source is a static file (default `~/.lumen/permissions.yaml`, override with `LUMEN_PERMISSIONS_PATH` or `--permissions-path`). Rules match on tool name + optional argument shape. Evaluation is **deterministic** (no LLM, no fuzzy matching) so the surface is testable in isolation. The middleware is a **layer in front of** the existing interrupt middleware, not a replacement — `permissions: allow` short-circuits before interrupt even runs.

## 2. P22 task breakdown

### 2.1 P22.0 — `BasePermissionPolicy` + `FilePermissionPolicy`

- `packages/core/src/agent/middleware/permission.ts` — `BasePermissionPolicy` interface with one method `evaluate(toolCall, ctx): PermissionDecision`. Helper function `createFilePermissionPolicy({ path, default?: 'allow' | 'deny' | 'ask' })` that loads a YAML file and produces a policy. The Zod schema is `PermissionPolicySchema` (`.strict()`) so a bad file fails at composition time, not at the first tool call.
- The policy entry shape:
  ```ts
  type PermissionRule = {
    name: string
    tools: string[]                              // glob or exact, validated at load
    decision: 'allow' | 'deny' | 'ask'
    when?: { argMatches?: Record<string, string> }  // arg key → regex
  }
  type PermissionPolicy = {
    version: 1
    default: 'allow' | 'deny' | 'ask'
    rules: PermissionRule[]
  }
  ```
- 6 unit tests: allow by exact tool name, deny by exact tool name, ask by default + matching tool, arg-match allow (e.g. `read_file` with `path: '*.md'` allow, others ask), arg-match deny, unknown tool → default.

### 2.2 P22.1 — `createPermissionMiddleware` + interrupt coexistence

- `createPermissionMiddleware({ policy }): AgentMiddleware` that wraps `wrapToolCall`. The middleware:
  1. Calls `policy.evaluate(toolCall, ctx)`.
  2. `allow` → `await defaultCall()`.
  3. `deny` → throws `AbortError('permission denied: <rule name>')`. The existing P20.4.2 catch path auto-saves a checkpoint tagged with `outcome: 'error'`.
  4. `ask` → falls through to `await defaultCall()`. The existing `createInterruptMiddleware({ toolNames: [toolCall.name], approve })` chain decides whether to abort.
- The middleware **must be ordered before** `createInterruptMiddleware` in the `middleware: []` array. Composition enforces the order at the CLI level (composition.ts sorts by name: `permission` → `interrupt`).
- 4 e2e tests: deny short-circuits before the interrupt middleware, allow skips both, ask chains correctly, deny persists the P20.4.2 checkpoint.

### 2.3 P22.2 — CLI surface: `lumen run --permissions <path>`

- `apps/cli/src/commands/run.ts` gains `permissionsPath?: string` and `apps/cli/src/commands/chat.tsx` gains the same.
- Composition wires `FilePermissionPolicy({ path: options.permissionsPath ?? defaultPermissionsPath() })` if either flag is set. When omitted, no permission middleware is wired (back-compat with pre-P22 behaviour).
- `defaultPermissionsPath()` returns `$LUMEN_PERMISSIONS_PATH ?? ~/.lumen/permissions.yaml`.
- A non-existent file → typed `ConfigError` ("no such file") with a hint to run `lumen init` (P22.4). A malformed file → typed `ConfigError` with the Zod issue list.

### 2.4 P22.3 — `lumen init` + `lumen permissions show`

- `apps/cli/src/commands/init.ts` — `lumen init [--force]` writes a starter `~/.lumen/permissions.yaml` with the default `default: 'ask'` policy and a handful of commented example rules. `--force` overwrites an existing file.
- `apps/cli/src/commands/permissions.ts` — `lumen permissions show [--path <file>]` prints the resolved policy in human-readable form. The shape matches `lumen checkpoint show` (P20.4.3) for operator consistency.

### 2.5 P22.4 — Default rule bundle + docs

- A `lumen permissions preset` subcommand that prints the recommended starter policy: `default: 'ask'`, with explicit `allow: [read_file, list_dir, search_files]` and `deny: [terminal]` (because every other framework auto-denies raw shell). No code in core — pure data ship via docs.
- `docs/PERMISSIONS.md` (operator-facing guide) with three worked examples: a single-developer local workflow, a CI pipeline, a security-paranoid enterprise setup. Cross-references `docs/P21-DESIGN.md` for the resume flow and `docs/P20-PITFALLS.md` (P20.1) for the interrupt behaviour.

## 3. 4-framework comparison

| Dimension | LangGraph 1.0 | Claude Code | OpenClaw | **Lumen P22** |
| --- | --- | --- | --- | --- |
| **Permission model** | `interrupt()` runtime call, dynamic pause | `permissions.allow/deny` static file + sandbox flag | policy file + opt-in auto mode + review queue | static YAML + 3-way decision (`allow` / `deny` / `ask` falling through to interrupt) |
| **Match surface** | arbitrary node code (`if x: interrupt('...')`) | tool name + path pattern + git/npm/GitHub source | tool name + allowFrom list + mention rules | tool name + argument regex |
| **Resume model** | `Command(resume=...)` returns the user's response to the calling node | next dispatch auto-evaluates the policy | review queue + human approval | falls through to existing `createInterruptMiddleware` `approve` callback (P20.1.2 follow-up) |
| **Storage** | checkpointer (Postgres / SQLite / Redis) | `~/.claude/settings.json` | `~/.openclaw/openclaw.json` | `~/.lumen/permissions.yaml` (default) or `LUMEN_PERMISSIONS_PATH` |
| **Approval / auto-approve** | full graph re-invoke with response | implicit (next-dispatch) | explicit `auto mode` opt-in | explicit `approve` callback on the interrupt middleware (P20.1.2) |
| **Audit** | state saved in checkpointer | implicit (allowed actions log) | Skill Card / VirusTotal scan | reuses P21.3 audit log + P20.4.2 checkpoint |
| **Approval flow on deny** | `Command(resume=...)` returns a rejection value | next call re-evaluates the policy | falls through to manual review | `AbortError('permission denied: <rule>')` → P20.4.2 auto-checkpoint |
| **Public docs** | ✅ | ✅ | ✅ (blog + features) | ✅ (this doc) |
| **Hermes parity** | n/a | n/a | n/a | n/a — Hermes public surface unverified |

Lumen's distinct line: **three-way decision** (`allow` short-circuits, `deny` aborts without human input, `ask` falls through to interrupt). Claude Code and OpenClaw collapse all three into "ask" (the only question is **who** answers: operator, sandbox, or a classifier). LangGraph collapses into "ask" by definition (no static allow/deny). The three-way shape is what the Lumen CLI's `--approve-on` flag already prefigures (P20.1.2 follow-up) — the static file just makes it policy-shaped instead of flag-shaped.

## 4. Key design decisions

1. **P22 is a sibling, not a replacement** for `createInterruptMiddleware`. The permission middleware is layer #1 (deterministic, no human input); the interrupt middleware is layer #2 (async, human input). Composition orders them by name. This keeps the P20.1 contract intact: a project that doesn't set `--permissions-path` behaves exactly as it did before P22.

2. **No fuzzy matching** — no LLM, no embeddings, no skill-based classification. The policy file is plain data; the dispatcher is a deterministic rule engine. The cost: a one-line "is this path sensitive" rule is hard. The benefit: every decision is auditable from a `git log` of the policy file, and tests are trivially deterministic (no mock models needed).

3. **`deny` does NOT checkpoint** (P20.4.2 path is for the interrupt-abort case, not a policy refusal). Actually, **this needs a 2nd thought** — see §5.

4. **`default: 'ask'` is the only safe default**. A new user running `lumen init` writes a file that asks the host on every call. Operators opt into `default: 'allow'` once they have reviewed the rule list. The starter bundle ships in P22.4 with `default: 'ask'` hard-coded.

5. **Permission layer cannot read tool call results** — only the call itself. This is the same constraint as Claude Code's allow/deny and prevents the policy from "just trust the call if the model says it worked". The argument-match surface is sufficient for the read_file / terminal / search_files cases the framework covers.

## 5. Open question (P22.0 implementation)

`deny` outcome: does it checkpoint via P20.4.2? My initial design said no ("deterministic refusal, no need to resume"). But — a denied `terminal` call is the same shape as a denied `write_file` to `/etc/passwd`; the operator may want to inspect what the agent tried to do before the refusal. **Decision deferred to the first P22.0 commit** with a default of `no checkpoint` (preserves the P20.4 contract) and a flag `--permissions-checkpoint-deny` to opt in.

## 6. Risk + mitigation

| Risk | Mitigation |
| --- | --- |
| `argMatches` regex is slow on large policy files | Cap policy at 1000 rules; document the limit in `PermissionPolicySchema`. |
| `deny` outcome is silent and the user doesn't know it happened | The middleware also records the decision in its state slice (same shape as P20.1.2's `InterruptDecision[]`); `lumen permissions audit` subcommand lists recent denies. |
| `default: 'ask'` is too noisy for the read-only case | The `lumen permissions preset` (P22.4) ships a permissive starter for the read-only case; operators customise. |
| Composition ordering bug (permission before interrupt) | The CLI composition sorts middleware by name; an integration test pins the order. |
| OpenClaw auto-mode (p22.5 follow-up?) becomes a runaway auto-approve | Deferred to P22.5. The three-way decision is the only P22 surface; auto-mode is "ask with classifier" which is a new design. |

## 7. Total budget

- 5 P-tickets × average 2-3 commits = **~12 commits**
- ~400 lines code (core types + Zod schema + CLI surface + 1 doc file)
- ~250 lines tests
- 1 minor changeset (core + cli)
- 0 LLM calls in the runtime path
- 0 new public types beyond the middleware contract; the YAML loader returns the existing `BasePermissionPolicy` interface

## 8. Verification

After every P22.x commit:
```bash
pnpm --filter @lumen/core typecheck
pnpm --filter @lumen/core exec vitest run test/permission.test.ts
pnpm --filter @lumen/cli typecheck
pnpm --filter @lumen/cli exec vitest run test/init.test.ts test/permissions.test.ts
```

The P22.4 docs commit additionally:
```bash
pnpm --filter @lumen/docs-site build   # verify the new docs page renders
```
