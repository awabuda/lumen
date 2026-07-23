# P28 design lock — beyond `lumen computer` (the native-dep path for bug.md #10)

> **Design-only pass.** P27 closed bug.md #10 via the
> P24.5 \u00a72 workaround elevated to a first-class CLI
> subcommand (`lumen computer <prompt>`). P28 documents
> the **path to a real native-dep Computer Use** \u2014 the
> only remaining "ship bug.md #10 as a true fix" surface
> \u2014 and names the three explicit user decisions that
> gate it. P28 ships **0 code commits by design**; the
> pass is a handbook.

## 0. Why P28

### 0.1 Source

`bug.md #10` (Computer Use) is the only remaining
bug.md item that P22.7 \u00a73 (\`better-sqlite3\`-only
guardrail) blocks. The P24.5 deferral note (commit
\`58b3ca5\`) listed three re-open conditions:

  1. **The P22.7 ABI-drift detector stabilises.** The
     P22.7 design doc says the guardrail is "lumen's
     native-dep tolerance is **better-sqlite3 only** until
     the auto ABI-drift detector ships and stabilises."
     P22.7 itself shipped a manual \`pnpm rebuild:native\`
     path; the auto detector is a future P-ticket.
  2. **A pure-JS implementation becomes viable.** No
     npm library currently ships a pure-JS Computer Use
     surface. Selenium 4 still needs a native WebDriver
     bridge; nut.js is a native dep.
  3. **Lumen drops its hermetic dev-sandbox story
     entirely.** This is the most invasive: the entire
     dev-sandbox / sandbox-by-default posture would
     change.

P28 replaces the implicit re-open list with an explicit
**path forward**: for each condition, name the
concrete next step + the P-ticket that ships it.

### 0.2 4-framework fetch verification (2026-07-23)

| Framework | URL fetched today | Key takeaway for P28 |
| --- | --- | --- |
| **Anthropic Computer Use** | `https://docs.anthropic.com/en/docs/agents/computer-use` (re-fetched 2026-07-23) | The Anthropic Computer Use API is a **hosted** model feature; clients send screenshots + tool calls over HTTPS. The reference Python SDK uses Playwright internally \u2014 no native dep. **A pure-JS port to Node is feasible**: the SDK is just REST + Playwright's CDP. P28 names this as the first concrete implementation option. |
| **OpenAI Computer-Using Agent** | `https://openai.com/index/new-ai-models-for-developers/` (re-fetched 2026-07-23) | OpenAI ships CUA as a hosted model (computer-use-preview); the operator-side stack is the same Playwright / Selenium shape. The lum en path is identical: invoke the hosted model, drive the browser locally. |
| **LangChain 1.0** | (re-use P23 \u00a73) | LangChain's `playwright-extract-text` and `playwright-click` are thin Playwright wrappers; no native dep. The lum en path: import `@playwright/test`-shaped APIs, ship a single \`computer_use\` tool. |
| **OpenClaw / Hermes** | (re-use P25 \u00a72) | Neither ships a Computer Use subcommand. The dominant industry pattern is "hosted model + local Playwright driver". |

**Synthesis**: the canonical native-dep-free Computer Use
shape is **hosted model + Playwright driver**. The
hosted-model side requires no code change in lum en (the
provider layer already accepts the Anthropic / OpenAI
CUA endpoints). The Playwright driver is already a
dependency (P24.1 added it). The remaining work is the
**agent-loop integration**: wire a new \`computer_use\`
tool (mirroring \`web_browser\`) that talks to Playwright
+ emits screenshot tool calls + consumes coordinate-
based action calls.

### 0.3 6-question audit (post-P27.3)

| # | Question | Lumen status (post-P27.3) | P28 path |
| --- | --- | --- | --- |
| 1 | Skill | full (P20.6 + P23.11.C) | full |
| 2 | Team | full (P19.3/4 + P20.7 + P25.1) | full |
| 3 | Workspace | full (P20.4 + P21.2) | full |
| 4 | Context | full (P6/P9) | full |
| 5 | Failure | full (P21.0/P21.1) | full |
| 6 | Security + Risk | full (P22.0 + P22.5 + P24.3) | full |
| 7 | Composition | full (P22.6) | full |
| 8 | External capability | full (P24.1 + P27.1) | full (Computer Use via P27.1 workaround) |
| 9 | MCP posture | full (P24.2 + P24.3) | full |
| 10 | MCP startup parallelism | full (P24.2) | full |

**No new audit axes.** P28 is an extension of the
"External capability" axis (axis 8). The audit does
not change.

## 1. The three re-open conditions (concrete paths)

### 1.1 Path A: hosted-model + Playwright driver (recommended)

- **What it ships**: a new \`computer_use\` tool
  (mirroring \`web_browser\`, P24.1). The tool is a
  Playwright wrapper that takes screenshots (data:
  PNG) and accepts coordinate-based action calls
  (\`click(x, y)\` / \`type(text)\` / \`key(keyName)\`).
  The agent loop composes the tool with the hosted
  Anthropic / OpenAI CUA model.
- **Native-dep exposure**: ZERO. Playwright is already
  a P24.1 dependency. The hosted-model side is
  provider-layer work (P28.x follow-up).
- **P22.7 \u00a73 guardrail status**: **no change**. The
  guardrail forbids a NEW native dep, not the use of an
  existing one. Playwright was approved by the P24.1
  commit body; CUA is hosted.
- **P-ticket**: P28.1 (implementation), P28.2 (provider
  layer), P28.3 (CLI \`--computer-use\` flag).

### 1.2 Path B: drop P22.7 \u00a73 entirely + ship a real native-dep

- **What it ships**: the existing P24.5 \u00a73 native-dep
  Computer Use (Selenium WebDriver or nut.js).
- **Native-dep exposure**: ONE additional native
  dep. The exact dep is operator-chosen.
- **P22.7 \u00a73 guardrail status**: **dismantled**. The
  P22.7 \u00a73 doc itself would be amended; the
  \`better-sqlite3\`-only constraint would become
  \`better-sqlite3 + operator-approved list\`.
- **P-ticket**: P28.4 (guardrail amendment) + P28.5
  (Computer Use implementation).

### 1.3 Path C: the hybrid

- **What it ships**: Path A's hosted-model +
  Playwright driver, **plus** the P22.7 auto-ABI-drift
  detector (P22.7 itself promised the detector as a
  follow-up). Once the detector is in production and
  has stabilised, the guardrail relaxes by default.
- **Native-dep exposure**: one-time Playwright (already
  present).
- **P-ticket**: P28.6 (auto-ABI-drift detector) + P28.7
  (Path A's implementation) + P28.8 (relax guardrail by
  default).

## 2. Recommended next step (no code)

The user is the decision-maker. P28.0 is a handbook;
no commit is required to advance. The recommended order
based on cost / value:

  1. **Path A** (cheapest, no guardrail change): ship a
     \`computer_use\` tool that wraps Playwright +
     delegates to the hosted Anthropic / OpenAI CUA
     model. Implementation cost: ~3 commits (P28.1 +
     P28.2 + P28.3).
  2. **Path C** (medium cost, but unlocks future
     native-dep expansion): ship P22.7's auto-ABI-drift
     detector first, then Path A. Implementation cost:
     ~5 commits (P28.6 + P28.7 + P28.8 + 2 tests).
  3. **Path B** (most expensive, most invasive): drop
     P22.7 \u00a73, ship Selenium / nut.js. Implementation
     cost: ~4 commits (P28.4 + P28.5 + 2 tests) PLUS
     the guardrail amendment is a hard architectural
     decision that affects every operator.

## 3. P28 commit shape

P28.0 ships ONLY this design lock (this commit). The
per-path P-tickets are P28.1 - P28.8; each lands with
its own design lock + implementation commits.

## 4. Footnotes (existing decisions reused)

- **Native-dep guardrail** (P22.7 \u00a73): NO change in
  P28.0. The three paths are listed; the user picks
  one.
- **Helper function > abstract class** (P19+ rule 15):
  any P28.x implementation uses helper functions.
- **Tier isolation** (P19+ rule 1): Path A lives in
  \`@lumen/tools\` (alongside \`web_browser\`) and
  \`@lumen/llm\` (alongside the existing provider
  layer). Path B is \`@lumen/tools\` only. Path C is
  cross-cutting.
