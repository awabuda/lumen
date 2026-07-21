---
'@lumen/core': minor
---

P23.5: Checkpoint save failures now log a structured warning (bug #7). Pre-P23.5 the `catch {}` block in `saveCheckpointBestEffort` silently swallowed persistence failures; users resuming after a crash had no way to tell whether the run crashed, the checkpoint save crashed, or both. The catch now calls `BaseLogger.warn` with `{ sessionId, iterations, outcome, error, errorName }`. The best-effort contract is preserved: the run result and the original error are never replaced by a checkpoint failure. All 4 call sites in `Agent.run` thread `this.logger` into the helper.