/**
 * @lumen/config — layered configuration for Lumen.
 *
 * Provides a single entry point ({@link loadConfig}) that merges configuration
 * from multiple sources in a fixed precedence order. Higher-priority sources
 * win. The whole stack is validated against a Zod schema at load time.
 *
 * Precedence (highest wins):
 *   1. CLI flags
 *   2. Environment variables
 *   3. Project config file (`./.lumen/config.yaml` or similar)
 *   4. User config file (`~/.lumen/config.yaml`)
 *   5. Built-in defaults
 *
 * Downstream packages import `LumenConfig` and helper accessors; they should
 * never read `process.env` directly.
 */

export { loadConfig, type LoadConfigOptions } from './loader.js'
export { defineConfig, type ConfigDefinition } from './define.js'
export { LumenConfigSchema, type LumenConfig } from './schema.js'
export { ConfigError } from './errors.js'
