/**
 * P27.0 design lock \u2014 `lumen computer` subcommand (bug.md #10 workaround as first-class CLI)
 *
 * > **Design-only pass.** P27 takes the deferred bug.md #10
 * \u2014 Computer Use (direct OS-level screen / keyboard / mouse
 * control) \u2014 and ships a workaround surface that does NOT
 * require a native dep. The P22.7 \u00a73 `better-sqlite3`-only
 * guardrail stays intact; this pass adopts P24.5 \u00a72
 * (operator workaround) as the canonical answer.
 *
 * ## 0. Why P27
 *
 * ### 0.1 Source
 *
 * `bug.md #10` is the only remaining bug.md item with
 * native-dep exposure. P24.5 documented the deferral and
 * the three re-open conditions (ABI-drift detector stable /
 * pure-JS implementation / hermetic-sandbox drop); none are
 * met today. The user's "继续完成" signal elevates the
 * priority of a workaround that DOES NOT require a
 * native dep.
 *
 * The P24.5 workaround is a one-liner the operator types
 * today:
 *
 *     lumen run --web-browser --approve-on web_browser \
 *         "navigate to example.com, log in as test, screenshot"
 *
 * This works. The cost is that the operator must know
 * (a) the `web_browser` tool exists, (b) the `--web-browser`
 * flag is opt-in, (c) the `--approve-on web_browser` flag
 * is required, (d) the agent loop will spend model calls
 * composing `goto` / `act` calls. P27 reduces the operator's
 * cognitive load by surfacing the shortcut as a first-class
 * subcommand.
 *
 * ### 0.2 4-framework fetch verification (2026-07-23)
 *
 * | Framework | URL fetched today | Key takeaway for P27 |
 * | --- | --- | --- |
 * | **Claude Code** | `https://docs.claude.com/en/docs/claude-code/cli-usage` (re-fetched 2026-07-23) | Claude Code does NOT ship a Computer Use subcommand; the workaround pattern (the agent loop composes Playwright calls) is exactly the surface P27 ships. |
 * | **LangChain 1.0** | (re-use P23 \u00a70.3) | No native-dep Computer Use surface ships. LangChain's `MultiModalEmbeddings` is for the embedding tier; not relevant. |
 * | **OpenClaw** | (re-use P23 \u00a70.3) | No Computer Use subcommand; the lighter-core-sharper-claws post explicitly de-prioritised this surface. |
 * | **Hermes Agent** | (re-use P25 \u00a70.2) | Hermes exposes `cron` + `memory` + `mcp`; no Computer Use subcommand. |
 *
 * **Synthesis**: the workaround pattern (P24.5 \u00a72) is
 * already the dominant industry pattern. P27 ships a
 * first-class CLI shortcut; it does not introduce new
 * capability.
 *
 * ### 0.3 6-question audit (post-P26.2)
 *
 * No new audit axes. P27 sits inside the existing
 * "External capability" axis (closed by P24.1) and the
 * existing "Composition" axis (closed by P22.6).
 *
 * ## 1. Architecture decisions (locked in this pass)
 *
 * ### 1.1 `lumen computer <prompt>` subcommand
 *
 * - **Scope**: a thin wrapper around `lumen run` that
 *   pre-sets `--web-browser --approve-on web_browser`. The
 *   body is the existing `runCommand` (P22.2) with a
 *   pre-applied flag set.
 * - **Why a subcommand, not just a flag**: the
 *   `--web-browser` + `--approve-on web_browser`
 *   combination is a frequent operator pattern. A
 *   dedicated subcommand names the intent; the agent
 *   loop can specialise its prompt template if we ever
 *   want (P28+).
 * - **No new code in `@lumen/core` / `@lumen/tools`** \u2014
 *   the surface is a CLI shortcut. P27 ships ONLY in
 *   `apps/cli/`.
 *
 * ### 1.2 Prompt prefix (optional)
 *
 * - The subcommand prepends a one-line hint to the
 *   operator's prompt:
 *
 *         [lumen computer] You have a headless Chromium
 *         browser available via the \`web_browser\` tool.
 *         Use goto / act / extract / screenshot. The
 *         operator has pre-approved every web_browser call.
 *
 *   Operators can opt out via `--no-prefix`.
 *
 * ### 1.3 Risk
 *
 * - `approval-required` flag is implied. Operators that
 *   want zero-prompt automation pass `--no-approve` (the
 *   `web_browser` tool will bypass the interrupt layer).
 * - The flag set is identical to `lumen run`; nothing
 *   new to learn.
 *
 * ## 2. P27 commit shape (P19+ rule #11 \u2014 commit-by-commit)
 *
 * | commit | shape | summary |
 * | --- | --- | --- |
 * | `docs: P27.0 design lock \u2014 lumen computer subcommand` (this commit) | design-only | `docs/P27-DESIGN.md` (this file) + `TASKS.md` P27 row. |
 * | `feat(cli): P27.1 \u2014 lumen computer subcommand` | cli + tests | new `apps/cli/src/commands/computer.ts` + `program.command('computer')` wiring. |
 * | `docs: P27 backfill TASKS + bug.md` | docs | adds commit rows + fixes bug.md status banner. |
 *
 * ## 3. Footnotes (existing decisions reused)
 *
 * - **Native-dep guardrail** (P22.7 \u00a73): NO change. P27
 *   ships a workaround, not a fix. #10 stays on the
 *   P28+ backlog.
 * - **Helper function > abstract class** (P19+ rule 15):
 *   \`lumen computer\` is a thin composition; no new
 *   abstract base.
 * - **Tier isolation** (P19+ rule 1): P27 lives entirely
 *   in `apps/cli/`.
 */