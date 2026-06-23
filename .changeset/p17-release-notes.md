---
"@lumen/cli": minor
---

P17 — real-model E2E harness + perf benchmark suite + CI matrix.

**New in `@lumen/cli`**

- `apps/cli/test/real-model/` — opt-in end-to-end test harness
  covering real LLM providers (OpenAI, Anthropic, Mistral,
  Ollama, llama.cpp) over the wire. Default-skipped via
  `LUMEN_E2E=1` opt-in; `pnpm --filter @lumen/cli test:e2e`
  entry point. Five scenarios: basic chat, tool calling,
  multi-step tool chain, streaming, memory persistence.
- `apps/cli/test/perf/` — opt-in performance benchmark
  harness, separated from E2E behind `LUMEN_BENCH=1` so
  correctness and latency suites can be enabled
  independently. Two scenarios: `agent.run` latency and
  `agent.streamRun` time-to-first-token. Reports p50 / p95
  / max per provider as a markdown table.
  `pnpm --filter @lumen/cli bench` entry point.
- `.github/workflows/ci.yml` — Node 20.x + 22.x CI matrix
  running typecheck + biome + test on every push to main
  and every PR. Workflow file ships in the default branch;
  picks up automatically on the next successful push.
- `apps/cli/test/real-model/helpers.ts` and
  `apps/cli/test/perf/helpers.ts` — env-driven provider
  factories, one each for `LUMEN_E2E_*` and `LUMEN_BENCH_*`
  env-var contracts. The split keeps the cost discipline
  of "developer who cares about correctness ≠ developer
  who cares about latency".

**MCP coverage** — `packages/mcp/test/stdio-integration.test.ts`
and `packages/mcp/test/http-integration.test.ts` already
ship real-subprocess integration tests (spawning
`fixtures/stdio-server.mjs` and `fixtures/http-server.mjs`
respectively), so no new code was needed for P17.2. This
release just acknowledges the existing coverage.

**Backwards compatibility** — the new `apps/cli/test/`
directories are unprivileged; they only run when the
matching env var is set. `pnpm test` on a fresh clone
with no env vars is unchanged: 12 passed, 7 skipped.
