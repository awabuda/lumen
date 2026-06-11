/** Test helpers shared by the memory test suite. */

/**
 * Pack a `number[]` into the Float32 little-endian byte
 * representation that {@link BruteForceVectorBackend} and
 * {@link SqliteVecBackend} expect. The result is a fresh
 * `Uint8Array` (no aliasing) so callers can hand it to
 * multiple backends in one test.
 */
export const floatsToBytes = (floats: ReadonlyArray<number>): Uint8Array => {
  const f32 = new Float32Array(floats.length)
  for (let i = 0; i < floats.length; i += 1) f32[i] = floats[i] ?? 0
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength).slice()
}
