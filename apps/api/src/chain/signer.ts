// ELIGIBILITY.md section 3 step 4: the service signs the 212-byte message
// with the eligibility key. Plain ed25519 over the raw bytes, the scheme the
// MESSAGES.md vectors were generated with.
import { ed25519 } from "@noble/curves/ed25519.js";

export interface EligibilitySigner {
  readonly pubkey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
}

export function eligibilitySigner(seed: Uint8Array): EligibilitySigner {
  if (seed.length !== 32) throw new Error("eligibility seed must be 32 bytes");
  const pubkey = ed25519.getPublicKey(seed);
  return { pubkey, sign: (message) => ed25519.sign(message, seed) };
}
