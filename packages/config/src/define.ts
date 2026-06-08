/**
 * User-facing helper for defining configuration in TypeScript.
 *
 * This exists for two reasons:
 *   1. Type inference: `defineConfig({ ... })` returns the inferred shape so
 *      you can compose it with `loadConfig`.
 *   2. Documentation: a typed builder makes it obvious which keys are valid.
 *
 * It is purely a typed identity function — no runtime behavior. The merge
 * happens in `loader.ts`.
 */

import type { LumenConfig } from './schema.js'

export type ConfigDefinition = LumenConfig

export const defineConfig = (config: ConfigDefinition): ConfigDefinition => config
