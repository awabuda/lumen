/**
 * Public extension surface for the concurrency module.
 *
 * Per `docs/ARCHITECTURE.md`, every package has exactly one `base.ts`
 * that re-exports the upstream base contract a downstream implementer
 * would subclass. The `concurrency` module lives inside `@lumen/core`
 * and provides cooperative async mutual exclusion primitives.
 *
 * Consumers should import the contract symbols from `@lumen/core`
 * directly; this file is the package's *internal* canonical place to
 * enumerate the extension seam.
 */

export {
  BaseMutex,
  Mutex,
  type AcquireTimeoutError,
  type MutexOptions,
  type AcquireResult,
} from './mutex.js'
