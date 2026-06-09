/**
 * Public extension surface for `@lumen/memory`.
 *
 * Per `docs/ARCHITECTURE.md`, every package has exactly one `base.ts`
 * that re-exports the upstream base contract a downstream implementer
 * would subclass. The `memory` package provides concrete stores
 * (in-memory and SQLite) on top of {@link BaseMemoryStore} from
 * `@lumen/core`.
 *
 * Consumers of `@lumen/memory` should import the contract symbols from
 * `@lumen/core` directly; this file is the package's *internal*
 * canonical place to enumerate the extension seam.
 */
export { BaseMemoryStore, type MemoryQuery, type MemoryRecord, type MemorySearchResult, type SessionMessage, type SessionRecord, } from '@lumen/core';
//# sourceMappingURL=base.d.ts.map