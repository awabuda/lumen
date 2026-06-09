/**
 * Driver that runs the {@link runStoreContractTests} against
 * {@link SqliteStore} using an **in-memory** database.
 *
 * Why in-memory? The contract is about behaviour, not disk.
 * An in-memory SQLite is hermetic (one test cannot see
 * another's tables), orders of magnitude faster than file
 * I/O, and avoids leaving temp files behind. We have a
 * separate file-backed test below to prove the WAL and
 * persistence paths actually work.
 */
import { SqliteStore } from '../src/sqlite-store.js'
import { runStoreContractTests } from './contract-suite.js'

runStoreContractTests('SqliteStore (memory)', async () => new SqliteStore({ path: ':memory:' }))
