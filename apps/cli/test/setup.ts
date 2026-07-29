/**
 * Vitest global setup for @lumen/cli.
 *
 * Audit 2026-07-29 GAP-2 follow-up: composition.ts now throws
 * `ConfigError` when no model resolves from the explicit chain
 * (CLI flag / config.defaultModel / LUMEN_MODEL /
 * LUMEN_DEFAULT_MODEL). The CLI test files were written under the
 * old hard-coded `'gpt-4o-mini'` fallback and pass `apiKey` but
 * not `model` to `buildAgent({...})`.
 *
 * Instead of editing every test (≈ 30 callsites), we inject a
 * test-only default via LUMEN_DEFAULT_MODEL. This keeps the
 * runtime behaviour honest (production still requires an
 * explicit model) while letting the existing fixtures build
 * cleanly. Real-model and perf tests can override via their own
 * LUMEN_E2E_* / LUMEN_BENCH_* env vars.
 */
process.env.LUMEN_DEFAULT_MODEL ??= 'gpt-4o-mini'
