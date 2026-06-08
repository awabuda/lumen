/**
 * Public extension surface for `@lumen/tools`.
 *
 * Per `docs/ARCHITECTURE.md`, every package has exactly one `base.ts` that
 * re-exports the upstream base contract a downstream implementer would
 * subclass. The `tools` package provides concrete filesystem tools; their
 * shared contract is {@link BaseTool} in `@lumen/core`.
 *
 * Consumers of `@lumen/tools` should import the contract symbols from
 * `@lumen/core` directly; this file is the package's *internal* canonical
 * place to enumerate the extension seam.
 */
export { BaseTool, ToolRegistry, type ToolContext, type ToolDescriptor, type ToolRisk, } from '@lumen/core';
//# sourceMappingURL=base.d.ts.map