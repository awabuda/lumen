/**
 * Public extension surface for the concurrency module.
 *
 * Re-exports {@link BaseMutex}, {@link Mutex}, and the related
 * error/schemas/types from `@lumen/core/src/index.ts`.
 */

export {
  AcquireTimeoutError,
  BaseMutex,
  Mutex,
  MutexDisposedError,
  MutexOptionsSchema,
  type AcquireResult,
  type MutexOptions,
} from './mutex.js'
