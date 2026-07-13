---
'@lumen/core': minor
---

Add an optional wall-clock checkpoint poll to `runWithHeartbeat` so long-running agents can forward the latest fresh in-progress snapshot to a caller-supplied observer at a deterministic interval.
