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

export { loadConfig, deepMerge, type LoadConfigOptions } from './loader.js'
export { defineConfig, type ConfigDefinition } from './define.js'
export {
  LumenConfigSchema,
  McpServerConfigSchema,
  type LumenConfig,
  type McpServerConfig,
} from './schema.js'
export { ConfigError } from './errors.js'
export {
  watchConfig,
  type ConfigWatcher,
  type ConfigWatchEvent,
  type WatchConfigOptions,
} from './watcher.js'
export {
  loadConfigWithProfile,
  listProfiles,
  resolveProfile,
  DEFAULT_PROFILE,
  type LoadConfigWithProfileOptions,
} from './profile.js'

// P25.8 (bug.md #52) — manifest-first config.
export {
  PackageManifestLumenSchema,
  PackageManifestSchema,
  parseLumenManifest,
  readLumenManifestFromDisk,
  resolveDefaultModel,
  DEFAULT_MODEL_PER_VERSION,
  type PackageManifestLumen,
  type PackageManifest,
} from './manifest.js'
// P33.B Day1 — ProductAssembly + profile schema. Pure data +
// a pure resolver; no `@lumen/core` dependency. Composition
// roots consume `resolveProductAssembly` /
// `profileNameToAssembly` to translate the resolved profile
// name to a concrete middleware-list assembly. The
// `assistant` assembly is the system default; `bare` is
// the operator opt-out.
export {
  BUILTIN_ASSEMBLIES,
  DEFAULT_ASSEMBLY,
  type AssemblyMiddlewareName,
  type AssemblyName,
  type ProductAssembly,
  profileNameToAssembly,
  resolveProductAssembly,
} from './product-assembly.js'
