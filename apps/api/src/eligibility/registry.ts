// ELIGIBILITY.md section 5: the profile is read from the chain as a 32-byte
// hash and mapped back to a registry id. The map is built once from the
// POLICY.md section 2.5 registry through the packages/shared derivation, so
// there is exactly one hash implementation on this path (SECURITY.md 5).
import { ELIGIBILITY_PROFILES, eligibilityProfileHash } from "@hackathon/shared";
import { bytesToHex } from "../bounties/policy.ts";

const ID_BY_HASH_HEX: ReadonlyMap<string, string> = new Map(
  [...ELIGIBILITY_PROFILES].map(([id, profile]) => [
    bytesToHex(eligibilityProfileHash(profile)),
    id,
  ]),
);

export function profileIdForHash(hash: Uint8Array): string | undefined {
  return ID_BY_HASH_HEX.get(bytesToHex(hash));
}

export function profileRequiresSgt(id: string): boolean {
  return ELIGIBILITY_PROFILES.get(id)?.requires_sgt === true;
}
