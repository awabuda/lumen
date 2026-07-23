/**
 * P25.8 (bug.md #52) — Manifest-first config loader.
 *
 * Reads the \`lumen\` block of a \`package.json\` and falls
 * back to \`~/.lumen/config.ts\` only when the block is
 * absent. Pre-P25.8 every lumen install had to ship a
 * separate \`lumen.config.yaml\` even when the project
 * already had a \`package.json\` with the right hints.
 *
 * The pattern mirrors OpenClaw's
 * \`pnpm.onlyBuiltDependencies\`-style install-time
 * metadata (P23-DESIGN \u00a70.2).
 *
 * Why a helper function (P19+ rule 15) and not an
 * abstract \`BaseManifest\` class: the loader is pure
 * data transformation (JSON \u2192 partial LumenConfig).
 * A class adds zero behavioural gain.
 */

import { z } from 'zod'

/**
 * The shape of the \`lumen\` block in \`package.json\`. We
 * keep it intentionally narrow \u2014 the block is a hint
 * surface, not a full config replacement. Operators who
 * need the full surface still ship a
 * \`.lumen/config.yaml\`.
 */
export const PackageManifestLumenSchema = z
  .object({
    /** Default model id (string). Maps to
     *  \`ToolPermissionPolicy.defaultModel\` when the
     *  YAML file is absent. */
    defaultModel: z.string().optional(),
    /** Short tag shown next to the version in \`lumen
     *  doctor\`. */
    tag: z.string().optional(),
    /** Optional list of tool names that are pre-approved
     *  for this project. Maps to \`approveOn\` when the
     *  YAML file is absent. */
    approveOn: z.array(z.string()).optional(),
    /** Optional list of tool names that the project
     *  explicitly forbids. Maps to \`neverAllowTools\`. */
    neverAllowTools: z.array(z.string()).optional(),
  })
  .strict()

export type PackageManifestLumen = z.infer<typeof PackageManifestLumenSchema>

/** Top-level package.json shape we read. Loose by design
 *  \u2014 \`package.json\` has hundreds of fields and we
 *  only care about \`name\`, \`version\`, and \`lumen\`. */
export const PackageManifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    lumen: PackageManifestLumenSchema.optional(),
  })
  .passthrough()

export type PackageManifest = z.infer<typeof PackageManifestSchema>

/** Pure parser: take a raw JSON object (already parsed
 *  from disk) and return the \`lumen\` block. Returns
 *  \`undefined\` when the block is absent or malformed
 *  (the loader falls back to \`~/.lumen/config.ts\`). */
export const parseLumenManifest = (
  raw: unknown,
): PackageManifestLumen | undefined => {
  const parsed = PackageManifestSchema.safeParse(raw)
  if (!parsed.success) return undefined
  return parsed.data.lumen
}

/**
 * Read \`package.json\` from disk and return the lumen
 * block. Uses \`node:fs\` directly so the helper is
 * usable from the config loader without a circular
 * import on \`@lumen/tools\`.
 */
export const readLumenManifestFromDisk = async (
  packageJsonPath: string,
): Promise<PackageManifestLumen | undefined> => {
  // We import \`node:fs/promises\` lazily so this module
  // is importable in browser / Deno / edge runtimes that
  // don't ship the Node fs module.
  const fs = await import('node:fs/promises')
  try {
    const text = await fs.readFile(packageJsonPath, 'utf8')
    const raw = JSON.parse(text)
    return parseLumenManifest(raw)
  } catch {
    // ENOENT / JSON parse error \u2014 treat as absent.
    return undefined
  }
}

/** Static lookup table for default models per lumen
 *  major version. Updated per release. */
export const DEFAULT_MODEL_PER_VERSION: Readonly<Record<number, string>> = {
  0: 'gpt-4o-mini',
  16: 'gpt-4o-mini',
}

/**
 * Resolve a default model id: try the manifest block,
 * then the per-version table, then the hard-coded
 * fallback. Pure helper; the caller wraps the result in
 * the policy file.
 */
export const resolveDefaultModel = (params: {
  readonly manifest?: PackageManifestLumen
  readonly lumenMajorVersion: number
}): string => {
  if (params.manifest?.defaultModel !== undefined) return params.manifest.defaultModel
  const perVersion = DEFAULT_MODEL_PER_VERSION[params.lumenMajorVersion]
  if (perVersion !== undefined) return perVersion
  return DEFAULT_MODEL_PER_VERSION[0] ?? 'gpt-4o-mini'
}