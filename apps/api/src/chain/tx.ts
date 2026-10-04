// POLICY.md section 19.9 (D151): the submit_attestation transaction, serialised by hand
// as a legacy message. Six account keys in a fixed order; the native ed25519
// instruction at index 0 carries the attester's signature over the message; the
// relayer pays and signs. No compute-budget instruction. 728 bytes.
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { ED25519_PROGRAM_ID, ed25519InstructionData } from "@hackathon/shared";

export const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
/** The first eight bytes of sha256("global:submit_attestation"). */
export const SUBMIT_ATTESTATION_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  0xee, 0xdc, 0xff, 0x69, 0xb7, 0xd3, 0x28, 0x53,
]);
export const ATTESTATION_TX_LENGTH = 728;

export interface AttestationTxInput {
  readonly relayerSeed: Uint8Array; // 32
  readonly bountyAccount: Uint8Array; // 32
  readonly configAccount: Uint8Array; // 32
  readonly programId: Uint8Array; // 32
  readonly attesterPubkey: Uint8Array; // 32
  readonly message: Uint8Array; // 261, the signed attestation
  readonly signature: Uint8Array; // 64, the attester's
  readonly blockhash: Uint8Array; // 32
}

function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const low = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(low);
      return out;
    }
    out.push(low | 0x80);
  }
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The message the relayer signs (legacy format). */
export function attestationTxMessage(input: AttestationTxInput): Uint8Array {
  const relayer = ed25519.getPublicKey(input.relayerSeed);
  const keys = [
    relayer,
    input.bountyAccount,
    input.configAccount,
    base58.decode(INSTRUCTIONS_SYSVAR),
    ED25519_PROGRAM_ID,
    input.programId,
  ];
  for (const k of keys) {
    if (k.length !== 32) throw new Error("every account key must be 32 bytes");
  }
  if (input.blockhash.length !== 32) throw new Error("blockhash must be 32 bytes");
  if (input.message.length !== 261) throw new Error("attestation must be 261 bytes");

  const verify = ed25519InstructionData(input.attesterPubkey, input.signature, input.message);
  const args = new Uint8Array(51);
  const view = new DataView(args.buffer);
  args.set(SUBMIT_ATTESTATION_DISCRIMINATOR, 0);
  args.set(input.message.slice(220, 252), 8); // evidence_root
  args[40] = input.message[252] as number; // achieved_assurance
  args.set(input.message.slice(253, 261), 41); // issued_at, little-endian i64
  view.setUint16(49, 0, true); // verification_instruction_index

  return concat([
    [1, 0, 4],
    compactU16(keys.length),
    ...keys,
    input.blockhash,
    compactU16(2),
    [4], compactU16(0), compactU16(verify.length), verify,
    [5], compactU16(3), [2, 1, 3], compactU16(args.length), args,
  ]);
}

/** The signed wire transaction and its base58 signature. */
export function attestationTransaction(input: AttestationTxInput): {
  wire: Uint8Array;
  signature: string;
} {
  const message = attestationTxMessage(input);
  const sig = ed25519.sign(message, input.relayerSeed);
  const wire = concat([compactU16(1), sig, message]);
  return { wire, signature: base58.encode(sig) };
}
