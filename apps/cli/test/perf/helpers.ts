/**
 * Performance benchmark helpers.
 *
 * Mirrors `../real-model/helpers.ts` but is wired to a separate
 * set of env vars (`LUMEN_BENCH_*` instead of `LUMEN_E2E_*`)
 * and a separate master switch (`LUMEN_BENCH=1`).
 *
 * Why two harnesses:
 *   - E2E (../real-model) asks "does the wire format still
 *     work?". It runs once per scenario per provider and
 *     asserts on the response shape.
 *   - Bench (./) asks "how fast is the wire format?". It runs
 *     N iterations per scenario per provider and reports
 *     p50 / p95 / p99 / max wall-clock latency.
 *
 * The split keeps cost discipline: an engineer who only cares
 * about regressions in correctness can opt into E2E; an
 * engineer who only cares about regressions in latency can
 * opt into Bench. Running both at once would burn twice the
 * API credits per CI run.
 *
 * Env vars recognised (mirrors the E2E set one-for-one, with
 * the prefix swapped):
 *   LUMEN_BENCH=1                              - master switch
 *   LUMEN_BENCH_OPENAI_API_KEY                 - OpenAI provider
 *   LUMEN_BENCH_OPENAI_BASE_URL (optional)     - default https://api.openai.com/v1
 *   LUMEN_BENCH_OPENAI_MODEL (optional)        - default gpt-4o-mini
 *   LUMEN_BENCH_ANTHROPIC_API_KEY              - Anthropic provider
 *   LUMEN_BENCH_ANTHROPIC_BASE_URL (optional)  - default https://api.anthropic.com
 *   LUMEN_BENCH_ANTHROPIC_MODEL (optional)     - default claude-haiku-4-5
 *   LUMEN_BENCH_MISTRAL_API_KEY                - Mistral provider
 *   LUMEN_BENCH_MISTRAL_BASE_URL (optional)    - default https://api.mistral.ai/v1
 *   LUMEN_BENCH_MISTRAL_MODEL (optional)       - default mistral-small-latest
 *   LUMEN_BENCH_OLLAMA_BASE_URL (optional)     - default http://127.0.0.1:11434
 *   LUMEN_BENCH_OLLAMA_MODEL (optional)        - default llama3.1
 *   LUMEN_BENCH_LLAMACPP_BASE_URL (optional)   - default http://127.0.0.1:8080/v1
 *   LUMEN_BENCH_LLAMACPP_MODEL (optional)      - default qwen2.5-7b
 *   LUMEN_BENCH_RUNS (optional)                - iterations per scenario, default 5
 *   LUMEN_BENCH_WARMUP (optional)              - warmup runs (discarded), default 1
 *
 * Cost discipline:
 *   - Default model per provider is the cheapest viable option
 *     that the E2E suite already exercises. Override via
 *     LUMEN_BENCH_*_MODEL if you want to measure a different
 *     model tier.
 *   - A full bench (5 runs × 2 scenarios × 5 providers) costs
 *     < $0.10 USD on the cloud providers and zero on the local
 *     ones. The suite warns above 20 runs.
 */

import type { BaseProvider } from '@lumen/core'
import {
  AnthropicProvider,
  LlamaCppProvider,
  MistralProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
} from '@lumen/llm'

/**
 * Master switch: LUMEN_BENCH=1 enables perf scenarios.
 *
 * Scenarios are skipped at the describe level when this is
 * false -- `pnpm test` in CI / in this repo stays green
 * without ever hitting a provider.
 */
export function benchEnabled(): boolean {
  return process.env.LUMEN_BENCH === '1'
}

export interface BenchProviderHandle {
  /** Stable id used for reporting (e.g. "openai"). */
  readonly id: 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'llamacpp'
  /** The constructed provider. */
  readonly provider: BaseProvider
  /** Model to pass to the provider on every call. */
  readonly defaultModel: string
}

/**
 * Build every provider that has its API key (or local URL)
 * configured. Returns an empty array if no provider is
 * configured -- scenarios iterate over the returned list and
 * each test runs once per provider.
 *
 * The factory uses `defaultModel` as a required field on every
 * Options object even where the option is optional in the
 * underlying class: bench scenarios always want a
 * deterministic model id, and guessing from `process.env`
 * per-call would make the timings unreproducible.
 */
export function getBenchProviders(): BenchProviderHandle[] {
  const out: BenchProviderHandle[] = []

  const openaiKey = process.env.LUMEN_BENCH_OPENAI_API_KEY
  if (openaiKey) {
    out.push({
      id: 'openai',
      provider: new OpenAICompatibleProvider({
        id: 'bench-openai',
        apiKey: openaiKey,
        baseUrl: process.env.LUMEN_BENCH_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        defaultModel: process.env.LUMEN_BENCH_OPENAI_MODEL ?? 'gpt-4o-mini',
      }),
      defaultModel: process.env.LUMEN_BENCH_OPENAI_MODEL ?? 'gpt-4o-mini',
    })
  }

  const anthropicKey = process.env.LUMEN_BENCH_ANTHROPIC_API_KEY
  if (anthropicKey) {
    out.push({
      id: 'anthropic',
      provider: new AnthropicProvider({
        id: 'bench-anthropic',
        apiKey: anthropicKey,
        baseUrl: process.env.LUMEN_BENCH_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        defaultModel: process.env.LUMEN_BENCH_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
      }),
      defaultModel: process.env.LUMEN_BENCH_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    })
  }

  const mistralKey = process.env.LUMEN_BENCH_MISTRAL_API_KEY
  if (mistralKey) {
    const mistralModel = process.env.LUMEN_BENCH_MISTRAL_MODEL ?? 'mistral-large-latest'
    out.push({
      id: 'mistral',
      provider: new MistralProvider({
        apiKey: mistralKey,
        baseUrl: process.env.LUMEN_BENCH_MISTRAL_BASE_URL ?? '',
        defaultModel: mistralModel,
      }),
      defaultModel: mistralModel,
    })
  }

  const ollamaBase = process.env.LUMEN_BENCH_OLLAMA_BASE_URL
  if (ollamaBase) {
    out.push({
      id: 'ollama',
      provider: new OllamaProvider({
        baseUrl: ollamaBase,
        defaultModel: process.env.LUMEN_BENCH_OLLAMA_MODEL ?? 'llama3.1',
      }),
      defaultModel: process.env.LUMEN_BENCH_OLLAMA_MODEL ?? 'llama3.1',
    })
  }

  const llamacppBase = process.env.LUMEN_BENCH_LLAMACPP_BASE_URL
  if (llamacppBase) {
    out.push({
      id: 'llamacpp',
      provider: new LlamaCppProvider({
        baseUrl: llamacppBase,
        defaultModel: process.env.LUMEN_BENCH_LLAMACPP_MODEL ?? 'qwen2.5-7b',
      }),
      defaultModel: process.env.LUMEN_BENCH_LLAMACPP_MODEL ?? 'qwen2.5-7b',
    })
  }

  return out
}

/**
 * Number of measured iterations per scenario per provider.
 * Override via `LUMEN_BENCH_RUNS` for ad-hoc deeper sampling.
 * Defaults to 5 -- enough to compute p50 / p95 / max, low
 * enough that a full bench stays under a dollar.
 */
export function benchRuns(): number {
  const raw = process.env.LUMEN_BENCH_RUNS
  if (!raw) return 5
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return 5
  return Math.min(parsed, 50)
}

/**
 * Number of warmup runs that are issued but discarded before
 * measurement starts. Warmup amortises cold-start cost
 * (process spawn, JIT, provider connection pool) so the
 * measured samples reflect steady-state latency.
 */
export function benchWarmup(): number {
  const raw = process.env.LUMEN_BENCH_WARMUP
  if (!raw) return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 1
  return Math.min(parsed, 10)
}

export interface LatencyStats {
  readonly count: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly meanMs: number
}

/**
 * Compute p50 / p95 / max / mean from a flat array of
 * millisecond samples. Uses nearest-rank percentile so the
 * result is stable across runs (no interpolation between
 * adjacent samples) -- makes regression diffs easier to
 * read.
 */
export function summariseLatency(samplesMs: readonly number[]): LatencyStats {
  if (samplesMs.length === 0) {
    return { count: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, meanMs: 0 }
  }
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const rank = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[idx] ?? 0
  }
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    count: sorted.length,
    p50Ms: round2(rank(50)),
    p95Ms: round2(rank(95)),
    maxMs: round2(sorted[sorted.length - 1] ?? 0),
    meanMs: round2(sum / sorted.length),
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Measure a single agent.run call in wall-clock milliseconds.
 * Centralised so every scenario uses the same high-resolution
 * timer (`process.hrtime.bigint`) and the same conversion
 * to ms, instead of re-inventing it per file.
 */
export async function timeAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const t0 = process.hrtime.bigint()
  const result = await fn()
  const t1 = process.hrtime.bigint()
  return { result, durationMs: Number(t1 - t0) / 1e6 }
}

/**
 * Render a single benchmark row as a markdown table row.
 * The format is stable across scenarios so a regression
 * detector can diff REPORT.md across runs.
 */
export function benchTableRow(
  providerId: string,
  scenario: string,
  stats: LatencyStats,
  extra?: string,
): string {
  const base = `| ${providerId} | ${scenario} | ${stats.count} | ${stats.p50Ms} | ${stats.p95Ms} | ${stats.maxMs} | ${stats.meanMs} |`
  return extra ? `${base} ${extra} |` : base
}

export const BENCH_TABLE_HEADER =
  '| provider | scenario | runs | p50 (ms) | p95 (ms) | max (ms) | mean (ms) |\n| --- | --- | ---: | ---: | ---: | ---: | ---: |'
