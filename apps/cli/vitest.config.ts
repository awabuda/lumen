import { defineConfig } from 'vitest/config'

/**
 * Vitest config for @lumen/cli.
 *
 * `setupFiles` points at `test/setup.ts`, which sets
 * `LUMEN_DEFAULT_MODEL=gpt-4o-mini` so the composition.ts
 * model-resolution chain has a value to resolve to. Without
 * this, the 2026-07-29 audit GAP-2 follow-up (throw on missing
 * model) would break every test that calls `buildAgent({...})`
 * without a `model:` field.
 *
 * See test/setup.ts for the full rationale.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
})
