/**
 * Public extension surface for `@lumen/llm`.
 *
 * Per `docs/ARCHITECTURE.md`, every package has exactly one `base.ts` that
 * re-exports the upstream base contract a downstream implementer would
 * subclass. Concrete implementations (such as
 * {@link OpenAICompatibleProvider} in `./openai-compatible.ts`) extend that
 * contract — they do not introduce new public surfaces.
 *
 * Consumers of `@lumen/llm` should import the contract symbols from
 * `@lumen/core` directly; this file is the package's *internal* canonical
 * place to enumerate the extension seam.
 */
export { BaseProvider, } from '@lumen/core';
//# sourceMappingURL=base.js.map