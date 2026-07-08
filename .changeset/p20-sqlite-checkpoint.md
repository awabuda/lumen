---
"@lumen/memory": minor
---

P20.4.4 — `SqliteCheckpointStore` (persistent checkpoint storage).

Adds `SqliteCheckpointStore` to `@lumen/memory` — a
`BaseCheckpointStore` implementation backed by `better-sqlite3`
with a dedicated `checkpoints` table. The store is independent
from `SqliteStore` (which holds facts + session messages) so
the two concerns stay separate; both can point at the same
file because SQLite's WAL mode allows concurrent readers + one
writer.

11 new unit tests in `test/sqlite-checkpoint-store.test.ts`
covering save/get/list/delete, idempotent upsert on duplicate
id, label preservation, complex message-history roundtrip
(including assistant tool calls and tool results), and a
"reopen the same file and read back" test that proves
cross-instance persistence.
