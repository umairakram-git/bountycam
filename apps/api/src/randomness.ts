import { randomBytes, randomUUID } from "node:crypto";

// POLICY.md section 2.1 (D54): one injectable randomness module, mirroring
// the clock. Production binds node:crypto; tests inject a deterministic
// double and assert the values propagate (tests 10 and 11). randomBytes
// feeds the salt; randomUUID assigns requirement ids.
export interface Randomness {
  randomBytes(length: number): Uint8Array;
  randomUUID(): string;
}

export const systemRandomness: Randomness = {
  randomBytes: (length) => randomBytes(length),
  randomUUID: () => randomUUID(),
};
