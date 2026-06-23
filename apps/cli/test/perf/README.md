# Perf benchmarks

`apps/cli/test/perf/` is the **opt-in** performance benchmark
suite for the Lumen agent loop. It exercises real LLM
providers (OpenAI, Anthropic, Mistral, Ollama, llama.cpp)
and reports wall-clock latency statistics.

Distinct from `../real-model/` (which is the E2E correctness
suite) and from the unit tests in `packages/*/test/` (which
use scripted fakes). The split is deliberate:

| Suite | Asks | Cost |
| --- | --- | --- |
| `packages/*/test/` | Does the unit still work? | Free |
| `test/real-model/` | Does the wire format still work? | < $0.05/run |
| `test/perf/` | How fast is the wire format? | < $0.10/run |

## When to run

- **Before merging a refactor of `packages/core/src/agent/`**:
  expected p50 should not regress by more than 10%.
- **Before bumping a default model in
  `packages/llm/src/<provider>.ts`**: capture a baseline, then
  compare the new model head-to-head on the same scenario set.
- **After a dependency upgrade on `openai` / `@anthropic-ai/sdk`
  / `ollama` HTTP client**: streaming TTFT is the first place
  regressions show up.

## How to run

Default: skipped. Opt in with `LUMEN_BENCH=1` plus per-provider
env vars:

```sh
# Local Ollama, no API key needed:
LUMEN_BENCH=1 \
LUMEN_BENCH_OLLAMA_BASE_URL=http://127.0.0.1:11434 \
LUMEN_BENCH_OLLAMA_MODEL=llama3.1 \
pnpm --filter @lumen/cli bench

# Cloud provider:
LUMEN_BENCH=1 \
LUMEN_BENCH_OPENAI_API_KEY=sk-... \
LUMEN_BENCH_OPENAI_MODEL=gpt-4o-mini \
pnpm --filter @lumen/cli bench
```

The `bench` script sets `LUMEN_BENCH=1` and runs the vitest
reporter in verbose mode. The markdown table is printed to
stdout; redirect to a file to keep a regression record:

```sh
pnpm --filter @lumen/cli bench 2>&1 | tee apps/cli/test/perf/REPORT.md
```

## Tuning

- `LUMEN_BENCH_RUNS=N` -- iterations per scenario (default 5,
  max 50). Increase to 20+ for a more stable p95.
- `LUMEN_BENCH_WARMUP=N` -- discarded warmup runs (default 1,
  max 10). Increase to 3 on first connection to a fresh
  provider; the first request on a cold connection is almost
  always 100-300ms slower than the median.

## What gets measured

- **Scenario 01: chat latency** -- one `agent.run` round-trip
  per run. Headline number for non-tool, non-streaming user
  exchanges.
- **Scenario 02: streaming TTFT** -- one `agent.streamRun` per
  run. Reports both TTFT (time to first `text:delta`) and
  total time. Local providers that buffer the full response
  (llama.cpp) will show TTFT ~ total -- that is a real signal,
  not a test failure.

## What's NOT measured (yet)

- Memory-persistence cost (scenario 05 in the E2E suite) is
  omitted here: SqliteStore write/read cost is dominated by
  disk I/O and is covered by the unit tests, not by latency
  benchmarks.
- Concurrent agent runs (load test) is intentionally not in
  the suite -- it would require a more sophisticated harness
  (coordinated cancellation, per-tenant rate-limit
  accounting) that is out of P17 scope.
- Tool-calling throughput is a worthwhile scenario but
  depends on a model reliably choosing to call the tool;
  without careful prompt engineering the run is dominated
  by model decision time, not transport time. Deferred to
  P18.

## Interpreting the table

Each row is `provider | scenario | runs | p50 (ms) | p95 (ms)
| max (ms) | mean (ms)`. The columns are independent: a
provider with a low p50 and a high max has a long tail (one
slow request in twenty), which is a different problem from a
provider whose p50 itself is regressing.

The `pnpm test` exit code is determined by the soft assertion
in each scenario: at least one run must complete under 60
seconds. The bench never fails on absolute latency -- the
table is the source of truth.
