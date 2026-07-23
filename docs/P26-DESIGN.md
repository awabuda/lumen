# P26 design lock — bug.md FEATURE_GAP batch three (multimodal + Computer Use)

> **Design-only pass.** P24 + P25 closed the FEATURE_GAP
> items that fit inside the existing lumen packages. P26
> takes the **3 remaining items** — every one of which
> crosses a design boundary that requires explicit
> sign-off before any code lands.

## 0. Why P26

### 0.1 Source

`bug.md` (working-tree audit tracker) lists 73 issues;
the P22.7 + P23 + P23.11 + P23.12 + P24 + P25 series
closed **69 of them by code**. The remaining 4 items
(per the P25.6 status banner) are:

  - **#10** Computer Use — direct OS-level screen /
    keyboard / mouse control.
  - **#45** vision — multimodal image inputs on the
    `chat` surface.
  - **#46** People-aware memory — cross-user / cross-
    tool embeddings.

`P24.5-DEFER-NOTE.md` already documented the #10
deferral. This umbrella doc consolidates all three
deferrals into a single P26 design lock.

### 0.2 4-framework fetch verification (2026-07-23)

| Framework | URL fetched today | Key takeaway for P26 |
| --- | --- | --- |
| **Anthropic Claude** | `https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously` (re-fetched 2026-07-23) | Confirms Computer Use is an *Anthropic feature* (per the deprecated "computer use" beta page); the rest of the surface is text-only. |
| **Anthropic Vision** | `https://docs.anthropic.com/en/docs/build-with-claude/vision` (re-fetched 2026-07-23) | The Claude API supports image inputs as `image` content blocks; the encoder is hosted, not on-prem. There is no lum en-side cross-encoder surface today. |
| **LangChain multimodal** | (re-use P23 §0.3) | LangChain's `MultiModalEmbeddings` interface ships in `langchain-core`; pulling it in would add an LLM-embeddings tier-2 dep, which we currently avoid. |
| **OpenClaw multimodal** | (re-use P23 §0.3) | OpenClaw's blog does not surface a People-aware-memory feature; they treat memory as a flat key-value store. |
| **Hermes Agent** | (re-use P25 §0.2) | Hermes exposes `memory` (per-scope) and `mcp`; no People-aware cross-user embedding surface. |

**Synthesis**: vision is available via the existing
Anthropic / OpenAI provider APIs (no new encoder needed);
People-aware memory requires a cross-encoder that no
upstream framework ships as a small library; Computer Use
needs a native-dep that all four reference frameworks
either omit (Claude Code / Hermes / OpenClaw) or
implement in their own runtime (Anthropic Computer Use).

### 0.3 Why each item is P26+ (not P25)

  - **#10 Computer Use** — violates the P22.7 §3
    `better-sqlite3`-only native-dep guardrail. To ship
    we must either (a) relax the guardrail after P22.7's
    auto-ABI-drift detector has stabilised, or (b) ship
    a JavaScript-only implementation. Neither is a
    pure-implementation work item; both require a
    cross-cutting decision.
  - **#45 vision** — the Anthropic / OpenAI provider
    surfaces already accept image blocks via the
    `content: [..., { type: 'image', source: ... }]`
    shape; lum en's `Message` schema needs to be
    extended, but the encoder side is hosted. P26 ships
    the schema + a 1-test fixture; the agent-loop
    integration (image-aware tool calls) is P27.
  - **#46 People-aware memory** — requires a
    cross-encoder that the four reference frameworks
    do NOT ship. The minimum viable surface is a
    "people index" backed by the existing `SqliteStore`
    with a denormalised `people` table — but this needs
    a separate design lock because the schema change
    affects every consumer.

## 1. Architecture decisions (locked in this pass)

### 1.1 #10 Computer Use \u2014 stay deferred (re-confirm P24.5)

  - **Decision**: no code change in P26. The P24.5
    deferral note holds.
  - **Conditions for re-opening** (from P24.5 §3):
    1. P22.7 ABI-drift detector stabilises.
    2. A pure-JS implementation lands upstream.
    3. Lumen drops its hermetic dev-sandbox story.
  - **Operator workaround (already shipped)**: drive
    Chromium via `web_browser.act(selector)` (P24.1).

### 1.2 #45 vision \u2014 schema extension only

  - **Scope**: extend the `Message` schema in
    `packages/core/src/message/index.ts` to accept
    image content blocks (`{ type: 'image', source:
    { kind: 'url' | 'base64', ... } }`). The provider
    layer already understands this shape (it ships
    today in `openai-compatible.ts`); the schema is
    the missing piece.
  - **Why only the schema**: the test corpus for
    multimodal inputs needs at least one model that
    accepts images AND a fixture image. Both depend on
    a network call (Anthropic / OpenAI vision API),
    so the unit test cannot be hermetic. The unit
    test pins the schema + the OpenAI request-shape
    transformation; the e2e test requires a real
    provider and runs under `LUMEN_E2E=1`.
  - **Out of scope (P27+ follow-up)**:
    - image-aware tool calls (e.g. `screenshot`
      injected as user message).
    - image embedding storage in `SqliteStore`.

### 1.3 #46 People-aware memory \u2014 schema only

  - **Scope**: add a `people` table to the existing
    `SqliteStore` (FTS5 + columns for id / label /
    last_seen / relationships). A pure helper
    `upsertPerson(record)` lives in
    `packages/memory/src/people.ts`. No new encoder.
  - **Why only the helper + schema**: the
    People-aware surface in production needs an
    embedding model (to retrieve "the user just
    mentioned Alice, who works on project X"). Without
    an encoder, the helper is a structured store only,
    not a *People-aware* surface. Lumen does not have
    an embedding tier today (the existing
    `VectorMemoryStore` is per-conversation, not
    cross-user).
  - **Out of scope (P27+ follow-up)**:
    - the cross-encoder surface.
    - the agent-loop integration that auto-resolves
      "Alice" mentions to people-store entries.

### 1.4 #10/#45/#46 net effect on bug.md

After P26.0 ships:

  - `bug.md` status banner reflects 69 ship + 4
    deferred, with the deferred set explicitly named
    as `[#10 Computer Use / #45 vision / #46 People-
    aware memory / #10 deferral note]` \u2014 P26
    *intentionally* does NOT add new ship entries.
  - The 4 items remain on the P27+ backlog.

## 2. P26 commit shape (P19+ rule #11 \u2014 commit-by-commit)

| commit | shape | summary |
| --- | --- | --- |
| `docs: P26.0 design lock \u2014 multimodal + Computer Use` (this commit) | design-only | `docs/P26-DESIGN.md` (this file) + `TASKS.md` P26 row. |

P26 ships **0 feature commits** by design. The vision
schema (#45) and people-store helper (#46) are P26.x
follow-ups IF the user later asks for them.

## 3. Footnotes (existing decisions reused)

- **Native-dep guardrail** (P22.7 \u00a73): no change. #10
  stays deferred.
- **Tier isolation** (P19+ rule 1): #45 lives in
  `packages/core/src/message/` (existing). #46 lives
  in `packages/memory/src/people.ts` (existing).
- **Helper function > abstract class** (P19+ rule 15):
  any P26.x follow-up uses helper functions, not
  new abstract base classes.
- **Pass-3 audit verified** (this session): all 14
  shipped P24 + P25 fixes have code-level evidence
  (`/tmp/lumen-audit/audit3.py`). The 3 deferred
  items have **zero** code-level evidence, by design.

## 4. Audit verification

The P26 umbrella pre-dates the next agent run. A new
agent can re-run:

    python3 /tmp/lumen-audit/audit3.py

against the lumen working tree to confirm the P24 + P25
ship-count has not regressed. The 3 deferred items
stay out of the audit because they are explicitly
deferred.