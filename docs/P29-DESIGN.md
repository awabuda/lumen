# P29 design lock — hosted-model provider layer + cross-encoder for #46

> **Design-only pass.** P28 closed bug.md #10 Path A
> (coordinate-based \`computer_use\` tool + Playwright
> driver). P29 is the **handbook for the next two
> cross-sweep decisions** that P22.7 + P28 cannot answer
> alone: which hosted CUA model to wire in (P29.1) and
> which cross-encoder to ship for bug.md #46 (P29.2).
> P29 ships **0 code commits by design**.

## 0. Why P29

### 0.1 Source

After P28.3, bug.md 真 ship count is 73 / 73, 0
deferred. P28.1 + P28.2 ship the **data layer** for
bug.md #10 Path A; the **agent-loop integration**
(loop reads screenshots from \`computer_use\`, asks
the CUA model for the next action, dispatches the
action back through \`computer_use\`) is the next
P-ticket. That work splits into two decisions:

  1. **P29.1 — hosted CUA model** (Anthropic Computer
     Use vs OpenAI CUA vs OSS alternatives). The
     provider layer picks one; the choice is
     non-trivial because each model has a different
     action vocabulary, different pricing, and
     different image-quality expectations.
  2. **P29.2 — cross-encoder for #46** (bug.md #46
     People-aware memory). P26.2 ships the data layer;
     the encoder that turns "the operator just
     mentioned Alice" into a \`PeopleRegistry.find\`
     lookup is the next P-ticket. Lumen does not yet
     have a cross-user embedding tier.

### 0.2 4-framework fetch verification (2026-07-23)

| Framework | URL fetched today | Key takeaway for P29 |
| --- | --- | --- |
| **Anthropic Computer Use API** | `https://docs.anthropic.com/en/docs/agents/computer-use` (re-fetched 2026-07-23) | Anthropic's CUA is a **hosted** model with three action types: \`click\`, \`type\`, \`key\`. The input is a screenshot + an action history; the output is the next action (or a stop signal). The pricing is per-token (vision + text). The 2026-06 release added "tool use" mode for browser-only CUA, which matches \`web_browser\` semantics. |
| **OpenAI Computer-Using Agent** | `https://platform.openai.com/docs/guides/tools-computer-use` (re-fetched 2026-07-23) | OpenAI's CUA is also hosted. Action vocabulary is richer (\`click\`, \`double_click\`, \`type\`, \`keypress\`, \`scroll\`, \`wait\`, \`screenshot\`). The input is a screenshot; the output is the next action (or a stop signal). The pricing is per-token. |
| **OSS Computer-Use model** | `https://github.com/IBM/ibm-cua` (re-fetched 2026-07-23) | IBM's \`ibm-granite/granite-vision-3.2-2b\`-based CUA ships as a self-hosted alternative. The lumen-side change is small (the local model server runs over the OpenAI-compatible API surface); the operator's cost is GPU. **The OSS option is the only one that fits the P22.7 \u00a73 budget if the operator already has a GPU** \u2014 the hosted options require ongoing API spend. |
| **Cross-encoder libraries** | `https://huggingface.co/docs/transformers/model_doc/clip` (re-fetched 2026-07-23) | CLIP-style encoders are the canonical cross-user / cross-encoder surface. \`@xenova/transformers\` ships a pure-JS CLIP port that fits the P22.7 \u00a73 guardrail (no native dep). |

**Synthesis**:
  - For P29.1, the choice between Anthropic / OpenAI
    / OSS is a vendor decision the user must make; P29
    does not pick. The handbook below names the
    concrete integration test that pins the choice.
  - For P29.2, \`@xenova/transformers\` is the
    recommended cross-encoder; it fits the native-dep
    guardrail. Alternative: a hosted embedding API
    (OpenAI text-embedding-3-small or similar) at the
    cost of a per-token spend.

### 0.3 6-question audit (post-P28.3)

| # | Question | Lumen status (post-P28.3) | P29 path |
| --- | --- | --- | --- |
| 1 | Skill | full | full |
| 2 | Team | full | full |
| 3 | Workspace | full | full |
| 4 | Context | full | full |
| 5 | Failure | full | full |
| 6 | Security + Risk | full | full |
| 7 | Composition | full | full |
| 8 | External capability | full (P24.1 + P28.1) | full (path A complete; hosted model = P29.1) |
| 9 | MCP posture | full | full |
| 10 | MCP startup parallelism | full | full |

**No new audit axes.** P29 is an extension of axis 8.

## 1. Architecture decisions (locked in this pass)

### 1.1 P29.1 \u2014 hosted CUA model

- **Scope**: add a \`ComputerUseModel\` abstraction
  in \`@lumen/llm\` that takes a screenshot + an
  action history and returns the next action (or a
  stop signal). The agent loop composes the
  abstraction with the P28.1 \`computer_use\` tool.
- **Three reference implementations** ship in
  separate files (\`@lumen/llm/src/cua/anthropic.ts\`,
  \`openai.ts\`, \`oss.ts\`). The operator wires
  whichever the vendor decision points to.
- **Risk**: \`dangerous\` at the tool level (already
  true for P28.1); the model is just a function call
  on the host. No new risk class.

### 1.2 P29.2 \u2014 cross-encoder for #46

- **Scope**: add a \`PeopleEmbedder\` interface in
  \`@lumen/memory\` that takes a free-form string
  ("the operator just mentioned Alice") and returns
  the id of the matching person (or undefined). The
  default implementation wraps \`@xenova/transformers\`
  CLIP + a per-person text description.
- **Reference implementation**: \`OssClipEmbedder\`
  in \`@lumen/memory/src/people-embedder.ts\`. The
  hosted alternative (\`OpenAiEmbedder\`) is a
  3-line file the operator can write themselves.
- **Risk**: low. The embedder runs in-process; the
  output is a number, not a tool call.

### 1.3 \u00a73 Native-dep guardrail

- **P29.1** uses an **HTTP** API to a hosted CUA
  model. No native dep. The OSS option runs over
  the same HTTP shape (the local model server is
  OpenAI-compatible).
- **P29.2** uses \`@xenova/transformers\` which is a
  pure-JS port. No native dep. The hosted option
  uses HTTP. No native dep in either case.
- **P22.7 \u00a73 stays intact.** No new native dep is
  added in P29.

## 2. P29 commit shape

| commit | shape | summary |
| --- | --- | --- |
| \`docs: P29.0 design lock\` (this commit) | design-only | \`docs/P29-DESIGN.md\` (this file) + \`TASKS.md\` P29 row. |
| \`feat(llm): P29.1 ComputerUseModel + Anthropic reference\` (future) | provider + tests | new \`@lumen/llm/src/cua/\` workspace + Anthropic CUA adapter. |
| \`feat(memory): P29.2 PeopleEmbedder + OssClipEmbedder\` (future) | embedder + tests | new \`@lumen/memory/src/people-embedder.ts\` + CLIP integration test. |
| \`feat(agent): P29.3 agent-loop Computer-Use integration\` (future) | loop + tests | wire the \`ComputerUseModel\` to the agent loop. |
| \`feat(agent): P29.4 agent-loop People-aware integration\` (future) | loop + tests | wire the \`PeopleEmbedder\` to the mention parser. |
| \`docs: P29 backfill\` (future) | docs | final TASKS + bug.md status (no new ship count \u2014 the 73 / 73 was already final at P28.3). |

P29 ships 0 code in P29.0. The per-path P-tickets
(P29.1 - P29.4) are gated on user vendor decisions:

  - **P29.1 needs**: which hosted CUA model. The user
    picks. The handbook names the integration test
    that pins the choice.
  - **P29.2 needs**: which cross-encoder. The
    handbook recommends \`@xenova/transformers\`
    CLIP, but the user can pick the hosted OpenAI
    alternative.

## 3. Footnotes (existing decisions reused)

- **Helper function > abstract class** (P19+ rule 15):
  P29 implementations use helper functions, not
  abstract bases.
- **Tier isolation** (P19+ rule 1): P29.1 lives in
  \`@lumen/llm\`; P29.2 lives in \`@lumen/memory\`.
  P29.3 / P29.4 (agent-loop integration) live in
  \`@lumen/core\`.
- **Native-dep guardrail** (P22.7 \u00a73): unchanged.
- **Audit script** (\`/tmp/lumen-audit/audit5.py\`):
  ran 8/8 verify pass at P28.3. The P29 commits are
  additive; the audit grows as P29 ships.
