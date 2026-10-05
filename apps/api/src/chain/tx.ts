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
  return attestationTxMessageFor(ed25519.getPublicKey(input.relayerSeed), input);
}

/**
 * The same message for a relayer named by its public key, so a recorded transaction can be
 * rebuilt without the relayer's seed (POLICY.md 19.14 test 19).
 */
export function attestationTxMessageFor(
  relayer: Uint8Array,
  input: Omit<AttestationTxInput, "relayerSeed">,
): Uint8Array {
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

// --- POLICY.md section 20.7 (D159, D162): settlement transactions ---
//
// Legacy messages built by hand. Key order: the fee payer; any further signers; writable
// non-signers in order of first appearance; read-only non-signers likewise; then the
// invoked programs. A key named writable anywhere is writable. The D163 records were
// built in this order, so tx.ts reproduces them byte for byte (test 2).

export interface AccountMetaIn {
  readonly key: Uint8Array;
  readonly writable: boolean;
}

export interface InstructionIn {
  readonly programId: Uint8Array;
  readonly accounts: readonly AccountMetaIn[];
  readonly data: Uint8Array;
}

const hexKey = (k: Uint8Array): string => Buffer.from(k).toString("hex");

/** feePayer signs and is writable; extraSigners sign and are read-only. */
export function legacyMessage(
  feePayer: Uint8Array,
  extraSigners: readonly Uint8Array[],
  instructions: readonly InstructionIn[],
  blockhash: Uint8Array,
): Uint8Array {
  if (blockhash.length !== 32) throw new Error("blockhash must be 32 bytes");
  const signers = [feePayer, ...extraSigners];
  const signerSet = new Set(signers.map(hexKey));
  const order: string[] = [];
  const writable = new Map<string, boolean>();
  const bytes = new Map<string, Uint8Array>();
  const note = (k: Uint8Array, w: boolean) => {
    if (k.length !== 32) throw new Error("every account key must be 32 bytes");
    const h = hexKey(k);
    if (!bytes.has(h)) {
      bytes.set(h, k);
      order.push(h);
      writable.set(h, w);
    } else if (w) {
      writable.set(h, true);
    }
  };
  for (const ix of instructions) for (const a of ix.accounts) note(a.key, a.writable);
  const programs = new Set(instructions.map((ix) => hexKey(ix.programId)));
  for (const ix of instructions) note(ix.programId, false);
  const rest = order.filter((h) => !signerSet.has(h));
  const wr = rest.filter((h) => writable.get(h) === true);
  const ro = rest.filter((h) => writable.get(h) !== true && !programs.has(h));
  const pr = rest.filter((h) => writable.get(h) !== true && programs.has(h));
  const keys = [...signers.map(hexKey), ...wr, ...ro, ...pr];
  const index = new Map(keys.map((h, i) => [h, i]));
  const parts: (Uint8Array | number[])[] = [
    [signers.length, extraSigners.length, ro.length + pr.length],
    compactU16(keys.length),
    ...keys.map((h) => (bytes.get(h) ?? Uint8Array.from(Buffer.from(h, "hex")))),
    blockhash,
    compactU16(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push([index.get(hexKey(ix.programId)) as number]);
    parts.push(compactU16(ix.accounts.length));
    parts.push(ix.accounts.map((a) => index.get(hexKey(a.key)) as number));
    parts.push(compactU16(ix.data.length));
    parts.push(ix.data);
  }
  return concat(parts);
}

/** The signed wire form: each signer's signature over the message, in key order. */
export function signedWire(message: Uint8Array, seeds: readonly Uint8Array[]): {
  wire: Uint8Array;
  signature: string;
} {
  const sigs = seeds.map((s) => ed25519.sign(message, s));
  return {
    wire: concat([compactU16(sigs.length), ...sigs, message]),
    signature: base58.encode(sigs[0] as Uint8Array),
  };
}

export const RELEASE_DISCRIMINATOR = Uint8Array.from(Buffer.from("fdf90fce1c7fc1f1", "hex"));
export const EXPIRE_ACCEPTED_DISCRIMINATOR =
  Uint8Array.from(Buffer.from("17526b3cd6ac3bbc", "hex"));
export const RESOLVE_DISCRIMINATOR = Uint8Array.from(Buffer.from("f696ecce6c3f3a0a", "hex"));
export const APPROVE_DISCRIMINATOR = Uint8Array.from(Buffer.from("454ad9247375614c", "hex"));
export const REJECT_DISCRIMINATOR = Uint8Array.from(Buffer.from("87073f5583726fe0", "hex"));

/** The addresses every settlement transaction needs, all 32 bytes. */
export interface SettlementKeys {
  readonly programId: Uint8Array;
  readonly config: Uint8Array;
  readonly bounty: Uint8Array;
  readonly requester: Uint8Array;
  readonly mint: Uint8Array;
  readonly vault: Uint8Array;
  readonly tokenProgram: Uint8Array;
  readonly associatedTokenProgram: Uint8Array;
  readonly systemProgram: Uint8Array;
}

function createIdempotent(
  k: SettlementKeys,
  payer: Uint8Array,
  account: Uint8Array,
  owner: Uint8Array,
): InstructionIn {
  return {
    programId: k.associatedTokenProgram,
    accounts: [
      { key: payer, writable: true },
      { key: account, writable: true },
      { key: owner, writable: false },
      { key: k.mint, writable: false },
      { key: k.systemProgram, writable: false },
      { key: k.tokenProgram, writable: false },
    ],
    data: Uint8Array.from([1]),
  };
}

/** release (escrow SPEC 7.7): the relayer pays; the Scout's payout account is created first. */
export function releaseMessage(
  k: SettlementKeys,
  relayer: Uint8Array,
  scout: Uint8Array,
  scoutPayout: Uint8Array,
  blockhash: Uint8Array,
): Uint8Array {
  return legacyMessage(relayer, [], [
    createIdempotent(k, relayer, scoutPayout, scout),
    {
      programId: k.programId,
      accounts: [
        { key: k.requester, writable: true },
        { key: k.config, writable: false },
        { key: k.bounty, writable: true },
        { key: k.mint, writable: false },
        { key: k.vault, writable: true },
        { key: scout, writable: false },
        { key: scoutPayout, writable: true },
        { key: k.tokenProgram, writable: false },
      ],
      data: RELEASE_DISCRIMINATOR,
    },
  ], blockhash);
}

/** expire_accepted (escrow SPEC 7.11): the relayer pays; the requester's account first. */
export function expireMessage(
  k: SettlementKeys,
  relayer: Uint8Array,
  requesterAccount: Uint8Array,
  blockhash: Uint8Array,
): Uint8Array {
  return legacyMessage(relayer, [], [
    createIdempotent(k, relayer, requesterAccount, k.requester),
    {
      programId: k.programId,
      accounts: [
        { key: k.requester, writable: true },
        { key: k.config, writable: false },
        { key: k.bounty, writable: true },
        { key: k.mint, writable: false },
        { key: k.vault, writable: true },
        { key: requesterAccount, writable: true },
        { key: k.tokenProgram, writable: false },
      ],
      data: EXPIRE_ACCEPTED_DISCRIMINATOR,
    },
  ], blockhash);
}

/** resolve (escrow SPEC 7.9): the arbiter signs, the relayer pays; outcome 0 pays the Scout. */
export function resolveMessage(
  k: SettlementKeys,
  relayer: Uint8Array,
  arbiter: Uint8Array,
  outcome: 0 | 1,
  destinationOwner: Uint8Array,
  destination: Uint8Array,
  blockhash: Uint8Array,
): Uint8Array {
  return legacyMessage(relayer, [arbiter], [
    createIdempotent(k, relayer, destination, destinationOwner),
    {
      programId: k.programId,
      accounts: [
        { key: arbiter, writable: false },
        { key: k.config, writable: false },
        { key: k.requester, writable: true },
        { key: k.bounty, writable: true },
        { key: k.mint, writable: false },
        { key: k.vault, writable: true },
        { key: destination, writable: true },
        { key: k.tokenProgram, writable: false },
      ],
      data: concat([RESOLVE_DISCRIMINATOR, [outcome]]),
    },
  ], blockhash);
}
