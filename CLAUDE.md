# Lumen Project Rules (for AI agents)

You are working inside the Lumen repository. Read `docs/ARCHITECTURE.md` first.
Everything below assumes you have.

## Hard rules

1. **Never** import from a higher-tier package. The dependency graph in
   ARCHITECTURE.md is enforced by the build, but respect it in your head first.
2. **Never** hardcode model names, file paths, or provider endpoints in
   application code. Use config or DI.
3. **Every** pluggable component must extend a base contract from its package's
   `base.ts`. No duck-typing.
4. **Every** public function takes a Zod schema for its inputs. The Zod schema
   is the single source of truth for type, runtime validation, and JSON Schema
   generation.
5. **Every** public exported symbol has a JSDoc block. We are a public API.
6. **No** `any` in committed code. `unknown` is fine; narrow it.
7. **No** try/catch that swallows. Re-throw or convert to a typed error.
8. **Tests are required** for every new function. Aim for ≥ 80% line coverage
   on the file you changed.
9. **No** new top-level folders. If you need a new package, propose it in your
   PR description and let the maintainer decide.

## Style

- TypeScript strict + `noUncheckedIndexedAccess`. The `tsconfig.base.json` is
  non-negotiable.
- Use biome for formatting. Two-space indent, single quotes, no semicolons
  (where biome allows), trailing commas.
- Prefer `import type` for type-only imports.
- Prefer `readonly` everywhere it doesn't hurt.
- Prefer `as const` for literal objects.
- Prefer discriminated unions over loose object shapes.

## Architecture style

The user explicitly asked for **inheritable, pluggable, independently runnable**
code. That means:

- **Inheritance > configuration.** When in doubt, define a base class with
  overridable methods, not a config object with boolean flags.
- **Composition over inheritance at the wiring level.** The `Agent` class is
  *composed of* a provider, a tool registry, a memory store, and a hook
  registry. Internally, each of those uses inheritance to expose behavior.
- **Each package has exactly one `base.ts` defining the public extension
  surface.** All other files in that package either implement that surface or
  are utilities used by implementations.
- **No global state.** If you need shared state, pass it through the
  constructor.
- **No singletons.** The closest we get is the registries, and they are
  injected, not imported as globals.

## Subagent workflow (for AI orchestrators)

If you are a subagent spawned to implement a specific unit, your contract is:

1. Read `docs/ARCHITECTURE.md` and the relevant `base.ts`.
2. Implement against the base contract. Do not invent new abstractions.
3. Write tests in the same directory as the implementation
   (`foo.ts` → `foo.test.ts`).
4. Run `pnpm --filter <package> test` and `pnpm --filter <package> typecheck`.
5. Report back: paths created, tests passing count, any deviations from the
   base contract (and why).

The orchestrator (the user, or another agent) will review your output before
merging.
