/**
 * Skill template expansion — parameter substitution for skill
 * instructions.
 *
 * P23.11 (fix #67) — Skills were previously fixed strings; the
 * prompt could not pass runtime arguments through (e.g.
 * `/code-review <branch>` from Claude Code). `expandSkillArguments`
 * walks an instruction fragment and replaces every occurrence of
 * `$ARGUMENTS` with the joined `arguments` array, and named
 * placeholders of the form `$NAME` (or `${NAME}`) with the
 * matching entry in `named`. Unresolved names are left
 * untouched so the operator can debug by seeing the raw token.
 *
 * The helper is a *pure function*: it does not touch the skill
 * class, the registry, or the application schema. Skill authors
 * call it from `apply()` (or wrap their instructions through a
 * registry-level helper) when their skill is parameter-aware.
 * P19+ rule 15 — helper function over an abstract base.
 */

const ARG_PLACEHOLDER = /\$ARGUMENTS/g

/**
 * Substitute `$ARGUMENTS` and named placeholders in `template`.
 *
 * - `$ARGUMENTS`     → `arguments.join(' ')` (or `''` when empty)
 * - `$NAME`          → `named['NAME']` if present, else unchanged
 * - `${NAME}`        → same lookup, brace form for safety
 *
 * Returns a new string; the input is not mutated.
 */
export const expandTemplate = (
  template: string,
  options: {
    readonly arguments?: ReadonlyArray<string>
    readonly named?: Readonly<Record<string, string>>
  } = {},
): string => {
  const args = options.arguments ?? []
  const named = options.named ?? {}
  const joined = args.join(' ')
  let out = template.replace(ARG_PLACEHOLDER, joined)
  // ${NAME} form first so the brace-delimited lookup runs
  // before the bare $-token pass (which only catches names
  // not preceded by an opening brace).
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key: string) =>
    Object.hasOwn(named, key) ? named[key]! : full,
  )
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (full, key: string) =>
    Object.hasOwn(named, key) ? named[key]! : full,
  )
  return out
}

/**
 * Walk an instruction fragment array and apply the same
 * substitution rules to each fragment. Empty input → empty
 * output. Linked files (which the registry expands separately)
 * are not touched here.
 */
export const expandInstructions = (
  instructions: ReadonlyArray<string>,
  options?: Parameters<typeof expandTemplate>[1],
): ReadonlyArray<string> => instructions.map((frag) => expandTemplate(frag, options))

/**
 * Convenience: take a {@link SkillContext} (or its
 * `metadata.arguments` / `metadata.named`) and produce a
 * fully-expanded instruction set. Returns the original array
 * when the context carries no parameters, so skill authors
 * that do not call this helper pay nothing.
 */
export const expandFromContext = (
  instructions: ReadonlyArray<string>,
  ctx: { readonly metadata?: Readonly<Record<string, unknown>> },
): ReadonlyArray<string> => {
  const meta = ctx.metadata ?? {}
  const rawArgs = meta.arguments
  const rawNamed = meta.named
  const args = Array.isArray(rawArgs)
    ? rawArgs.filter((a): a is string => typeof a === 'string')
    : undefined
  const named =
    rawNamed && typeof rawNamed === 'object' && rawNamed !== null
      ? (rawNamed as Record<string, string>)
      : undefined
  if (!args && !named) return instructions
  return expandInstructions(instructions, { arguments: args, named })
}
