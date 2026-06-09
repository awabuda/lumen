/**
 * Driver that runs the {@link runStoreContractTests} against
 * {@link InMemoryStore}.
 *
 * Lives in its own file so failures here don't accidentally
 * take the SQLite driver down with them.
 */
import { InMemoryStore } from '../src/in-memory-store.js'
import { runStoreContractTests } from './contract-suite.js'

runStoreContractTests('InMemoryStore', async () => new InMemoryStore())
