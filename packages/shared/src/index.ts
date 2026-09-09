/**
 * Canonicalisation and hashing primitives.
 *
 * This module is the ONLY place in the monorepo where canonicalisation
 * and hashing are implemented. Do not reimplement these elsewhere —
 * import them from @hackathon/shared.
 */

/**
 * Serialise an object into its canonical string form.
 *
 * Rules:
 * - object keys are sorted lexicographically at every nesting depth
 * - all numbers are serialised as strings
 *
 * The output must be byte-for-byte deterministic for equal inputs so it
 * can be hashed and verified across mobile, API, and on-chain contexts.
 */
export function canonicalise(obj: unknown): string {
  throw new Error("not implemented");
}

/**
 * SHA-256 digest of the given bytes.
 *
 * @returns the 32-byte digest
 */
export function sha256(bytes: Uint8Array): Uint8Array {
  throw new Error("not implemented");
}

/**
 * Merkle root of a list of leaf hashes.
 *
 * @param hashes ordered list of 32-byte leaf hashes
 * @returns the 32-byte Merkle root
 */
export function merkleRoot(hashes: Uint8Array[]): Uint8Array {
  throw new Error("not implemented");
}
