/**
 * `lumen model` — list and inspect configured models.
 *
 * Sub-commands:
 *   - `list`  (default): print every entry from `config.models` plus a
 *     derived `default` row when `config.defaultModel` is set.
 *   - `show <name>`: print a single model entry.
 *   - `providers`: list every entry from `config.providers` (apiKey is
 *     redacted to `***`).
 *
 * No network calls. This command is purely a window into the merged
 * `LumenConfig` object that `loadConfig` would otherwise hand to the
 * agent runtime.
 */

import { loadCliConfig } from '../composition.js'

export interface ModelListOptions {
  /** Optional path to a Lumen config file. */
  readonly configPath?: string
}

/** Options for `lumen model show`. */
export interface ModelShowOptions {
  /** Override config path. */
  readonly configPath?: string
  /** Name of the model to print (matches `ModelConfig.name`). */
  readonly name: string
}

/** Options for `lumen model providers`. */
export interface ModelProvidersOptions {
  /** Override config path. */
  readonly configPath?: string
}

const redactApiKey = (key: string | undefined): string => {
  if (!key) return '(unset)'
  if (key.length <= 8) return '***'
  return `${key.slice(0, 4)}…${key.slice(-4)} (redacted, ${key.length} chars)`
}

/**
 * `lumen model list` — print every model from `config.models` plus the
 * resolved default. Exit 0 even when no models are configured (the
 * user may rely on `defaultModel` only).
 */
export const modelListCommand = async (opts: ModelListOptions = {}): Promise<number> => {
  const config = await loadCliConfig(opts.configPath)
  const models = config.models

  process.stdout.write(
    `Lumen models (${models.length} configured, default=${config.defaultModel ?? '(none)'})\n\n`,
  )
  if (models.length === 0) {
    process.stdout.write('  No models configured. Add entries under `models:` in your config.\n')
    return 0
  }

  for (const m of models) {
    const isDefault = m.name === config.defaultModel
    const tag = isDefault ? ' [default]' : ''
    process.stdout.write(`  ${m.provider}/${m.name}${tag}\n`)
    if (m.temperature !== undefined) process.stdout.write(`    temperature: ${m.temperature}\n`)
    if (m.maxTokens !== undefined) process.stdout.write(`    maxTokens:   ${m.maxTokens}\n`)
    if (m.topP !== undefined) process.stdout.write(`    topP:        ${m.topP}\n`)
    if (m.reasoning !== undefined) process.stdout.write(`    reasoning:   ${m.reasoning}\n`)
  }
  return 0
}

/** `lumen model show <name>` — print one model entry. */
export const modelShowCommand = async (opts: ModelShowOptions): Promise<number> => {
  const config = await loadCliConfig(opts.configPath)
  const match = config.models.find((m) => m.name === opts.name)
  if (!match) {
    process.stderr.write(`Model not found: ${opts.name}\n`)
    return 1
  }
  process.stdout.write(`${match.provider}/${match.name}\n`)
  process.stdout.write(`  temperature: ${match.temperature ?? '(default)'}\n`)
  process.stdout.write(`  maxTokens:   ${match.maxTokens ?? '(default)'}\n`)
  process.stdout.write(`  topP:        ${match.topP ?? '(default)'}\n`)
  process.stdout.write(`  reasoning:   ${match.reasoning ?? '(default)'}\n`)
  process.stdout.write(`  default:     ${match.name === config.defaultModel ? 'yes' : 'no'}\n`)
  return 0
}

/** `lumen model providers` — list configured provider entries (apiKey redacted). */
export const modelProvidersCommand = async (opts: ModelProvidersOptions = {}): Promise<number> => {
  const config = await loadCliConfig(opts.configPath)
  const providers = config.providers

  process.stdout.write(`Lumen providers (${providers.length} configured)\n\n`)
  if (providers.length === 0) {
    process.stdout.write(
      '  No providers configured. Add entries under `providers:` in your config.\n',
    )
    return 0
  }

  for (const p of providers) {
    process.stdout.write(`  ${p.id}\n`)
    process.stdout.write(`    apiKey:     ${redactApiKey(p.apiKey)}\n`)
    if (p.baseUrl) process.stdout.write(`    baseUrl:    ${p.baseUrl}\n`)
    if (p.defaultModel) process.stdout.write(`    defaultModel: ${p.defaultModel}\n`)
    if (p.timeoutMs !== undefined) process.stdout.write(`    timeoutMs:  ${p.timeoutMs}\n`)
    if (p.headers) {
      const headerKeys = Object.keys(p.headers)
      if (headerKeys.length) process.stdout.write(`    headers:    ${headerKeys.join(', ')}\n`)
    }
  }
  return 0
}
