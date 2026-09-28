// POLICY.md section 15.3 step 2: program-derived addresses, as the Solana
// runtime derives them. sha256 over the seeds, the bump byte, the program id
// and the literal ProgramDerivedAddress; bumps from 255 down; the first hash
// that is not a valid ed25519 point wins. The on-curve test accepts the same
// encodings as the runtime's decompression, non-canonical y included, which
// is noble's zip215 mode. Vectors: the live config account (test 1) and the
// first funded bounty (test 2).
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@hackathon/shared";

const MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes, true);
    return true;
  } catch {
    return false;
  }
}

export interface ProgramAddress {
  readonly address: Uint8Array; // 32 bytes
  readonly bump: number;
}

export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: Uint8Array,
): ProgramAddress {
  const seedLength = seeds.reduce((n, s) => n + s.length, 0);
  for (let bump = 255; bump >= 0; bump--) {
    const buf = new Uint8Array(seedLength + 1 + programId.length + MARKER.length);
    let offset = 0;
    for (const s of seeds) {
      buf.set(s, offset);
      offset += s.length;
    }
    buf[offset++] = bump;
    buf.set(programId, offset);
    offset += programId.length;
    buf.set(MARKER, offset);
    const hash = sha256(buf);
    if (!onCurve(hash)) return { address: hash, bump };
  }
  throw new Error("no program address for these seeds");
}

const BOUNTY_SEED = new TextEncoder().encode("bounty");

/** The bounty account's address (escrow SPEC 4): seeds bounty, requester, bounty_id. */
export function bountyAddress(
  requester: Uint8Array,
  bountyId: Uint8Array,
  programId: Uint8Array,
): ProgramAddress {
  return findProgramAddress([BOUNTY_SEED, requester, bountyId], programId);
}
