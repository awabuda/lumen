/**
 * P31.1 — System prompt cache boundary primitive.
 *
 * OpenClaw-style marker-based split (`<!-- LUMEN_CACHE_BOUNDARY -->`).
 * The marker separates the **stable** prefix (kernel + project
 * + optional persona/guidance/skills/bootstrap, all byte-stable
 * across turns) from the **dynamic** suffix (runtime time/session
 * metadata + per-turn middleware injects).
 *
 * The split drives two behaviours:
 *
 *   1. Anthropic prompt-cache (`cache_control` on the stable
 *      prefix only — wired in `packages/llm/src/anthropic.ts`,
 *      P31.5). Other providers receive one string with the
 *      marker in-place; that is fine, the marker is invisible
 *      text for them.
 *   2. Hermes-style per-session byte-stable invariant: the
 *      stable prefix's bytes are invariant under any operation
 *      that does not touch a layer's source (cwd, project file
 *      mtime, profile, guidance version, skill index).
 *
 * Invariants pinned in `test/system-prompt-boundary.test.ts`
 * per P31 design doc §2.1.
 */

export const SYSTEM_PROMPT_CACHE_BOUNDARY = '<!-- LUMEN_CACHE_BOUNDARY -->'

/**
 * Two halves of a system prompt string split by the marker.
 *
 * `prefix` is the stable portion (kernel + project + optional layers);
 * `suffix` is the dynamic portion (runtime metadata + middleware
 * injects). The marker itself is **not** present in either half —
 * callers that need the raw two-string form can reconstruct it via
 * `joinWithBoundary`. See the design doc §1.1 for why we always
 * recompute both halves rather than storing the raw string.
 */
export interface BoundarySplit {
  readonly prefix: string
  readonly suffix: string
}

/**
 * Locate the boundary marker in a system prompt. Returns the
 * index of the **start** of the marker (i.e. where the dynamic
 * suffix begins) or `-1` when no marker exists. The marker is
 * treated as a single token; we don't try to be clever with
 * substrings — `ensureSystemPromptCacheBoundary` always installs
 * exactly one full marker.
 */
export const findSystemPromptCacheBoundary = (prompt: string): number =>
  prompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)

/**
 * Ensure the system prompt ends with the marker. If the marker
 * is absent, append it on a fresh line so the dynamic suffix
 * can be appended via {@link appendDynamic} regardless of
 * whether the caller supplied any suffix yet.
 *
 * This is the only API that mutates a string to include the
 * marker — every other helper either preserves an existing
 * marker or produces a new prompt built from scratch via
 * `splitByBoundary` + `joinWithBoundary`.
 */
export const ensureSystemPromptCacheBoundary = (prompt: string): string => {
  if (prompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)) return prompt
  return `${prompt}\n${SYSTEM_PROMPT_CACHE_BOUNDARY}\n`
}

/**
 * Split a system prompt into its stable prefix and dynamic
 * suffix at the marker. If the marker is absent, the entire
 * prompt is treated as prefix (suffix is empty) — defensive
 * default that lets the assembler keep working when a caller
 * forgot to call `ensureSystemPromptCacheBoundary`.
 */
export const splitByBoundary = (prompt: string): BoundarySplit => {
  const idx = findSystemPromptCacheBoundary(prompt)
  if (idx === -1) return { prefix: prompt, suffix: '' }
  const suffixStart = idx + SYSTEM_PROMPT_CACHE_BOUNDARY.length
  // Trim any leading newline from the suffix so the dynamic
  // block starts cleanly. trimStart() is intentional — the
  // suffix is the per-turn ephemeral surface, trimming here
  // does not affect the stable prefix.
  return {
    prefix: prompt.slice(0, idx),
    suffix: prompt.slice(suffixStart).replace(/^\n+/, ''),
  }
}

/**
 * Append a chunk to the dynamic suffix. Idempotent at the
 * marker layer: re-calling with the same chunk produces a
 * string that, when split again, has the same `{prefix, suffix}`
 * shape (modulo appended chunk count).
 *
 * The chunk is separated from any preceding dynamic content by
 * a single blank line so the resulting suffix reads naturally
 * when rendered by an LLM. The chunk should already be the
 * prose the LLM should see — this helper does **not** perform
 * sanitisation on the chunk itself; callers are responsible
 * for excluding tool schemas and other forbidden content
 * (design doc §1.3 R1).
 */
export const appendDynamic = (prompt: string, chunk: string): string => {
  if (chunk.length === 0) return prompt
  const ensured = ensureSystemPromptCacheBoundary(prompt)
  const { suffix } = splitByBoundary(ensured)
  const joined = suffix.length === 0 ? chunk : `${suffix}\n\n${chunk}`
  // Reuse the split's prefix so we never re-emit a marker
  // (defensive: ensureBoundary may have just installed one).
  const { prefix } = splitByBoundary(ensured)
  return `${prefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}\n${joined}`
}

/**
 * Build a fresh system prompt from a stable prefix and a
 * dynamic suffix. The marker is inserted between them at most
 * once; an empty suffix still produces a marker, which is the
 * OpenClaw invariant (subsequent `appendDynamic` calls always
 * land in the suffix).
 */
export const joinWithBoundary = (prefix: string, suffix = ''): string => {
  // Defensive: if a caller embedded the literal marker inside
  // either the prefix or the suffix, strip the *embedded* marker
  // so the output carries exactly one. We only strip on
  // detected presence; an ordinary string that happens to
  // contain "boundary" must not be parsed as a marker (the
  // marker is the *full* literal, including the comment
  // delimiters, so substring collisions are extremely
  // unlikely — but we still gate the parse on `includes`
  // before treating the input as already-split).
  const cleanPrefix = prefix.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)
    ? splitByBoundary(prefix).prefix
    : prefix
  const cleanSuffix = suffix.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)
    ? splitByBoundary(suffix).suffix
    : suffix
  return `${cleanPrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}\n${cleanSuffix}`
}

/**
 * Strip the marker from a system prompt. Used by providers
 * that don't speak the marker protocol (e.g. OpenAI in v1,
 * per design doc §1.8) — they receive the raw prose without
 * any cache-boundary control surface. The split is performed
 * first so callers can still inspect stable-vs-dynamic before
 * stripping if they wish.
 */
export const stripBoundary = (prompt: string): string => {
  const { prefix, suffix } = splitByBoundary(prompt)
  const body = suffix.length > 0 ? `${prefix}\n\n${suffix}` : prefix
  return body
}
