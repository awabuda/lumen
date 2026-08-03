# @lumen/cli

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
