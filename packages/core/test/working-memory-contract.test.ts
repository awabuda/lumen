/**
 * Wires {@link runWorkingMemoryContractTests} against the
 * concrete working-memory implementation shipped by
 * `@lumen/core`. Add new implementations here.
 */

import { RingBufferWorkingMemory } from '../src/memory/working-memory.js'
import { runWorkingMemoryContractTests } from './working-memory-contract-suite.js'

runWorkingMemoryContractTests('RingBufferWorkingMemory (default capacity)', () =>
  new RingBufferWorkingMemory(),
)
runWorkingMemoryContractTests('RingBufferWorkingMemory (capacity=3)', () =>
  new RingBufferWorkingMemory(3),
)
