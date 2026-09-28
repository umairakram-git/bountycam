// POLICY.md section 16.12 (D123 ruling 5): the race gate's laptop Scout. A
// development tool, not a test. It signs in by SIWS as ~/bountycam-keys/scout2.json,
// counts down 3, 2, 1, and requests a voucher at GO while the operator taps
// Accept on the A30. If it wins the reservation, it checks the voucher, builds
// `accept` with the packages/shared helpers exactly as the phone does
// (DISCOVERY.md 3.3), sends it, and reports (POLICY.md 16.8). Raw HTTP status
// and body are printed for every call.
//
// Usage:
//   node apps/api/scripts/scout-race.mjs --self-test
//   node apps/api/scripts/scout-race.mjs <bounty-id>
//
// --self-test signs AUTH.md section 12's worked vector with the RFC 8032 test
// key through this script's own message path and requires the published
// signature byte for byte. It touches no network and no key file.
import { createPrivateKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSignInMessageText } from "@solana/wallet-standard-util";
import {
  ED25519_PROGRAM_ID,
  ELIGIBILITY_PROFILES,
  acceptData,
  checkAcceptInstructions,
  checkVoucher,
  ed25519InstructionData,
  eligibilityProfileHash,
  expectedAcceptKeys,
  uuidBytes,
} from "@hackathon/shared";

// web3.js is the phone's dependency; resolving it from apps/mobile gives the
// script the same wire encoding the phone uses. Loaded after --self-test, which
// needs only node:crypto and the SIWS builder.
function loadWeb3() {
  return createRequire(new URL("../../mobile/package.json", import.meta.url))(
    "@solana/web3.js",
  );
}

const API = "http://127.0.0.1:3000";
const RPC = "https://api.devnet.solana.com";
const KEY_FILE = join(homedir(), "bountycam-keys", "scout2.json");
const PROGRAM_ID = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";
const ELIGIBILITY_AUTHORITY = "Bg6SsTTH6EX5AaeQQ9i4yhDTwsSjxnHx9AV8cqa97xmp";
const DEPLOYMENT_ID = 2;

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function signBytes(seed, bytes) {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, Buffer.from(bytes), key);
}

function selfTest() {
  const seed = Buffer.from(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  );
  const message = createSignInMessageText({
    domain: "app.example.com",
    address: "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z",
    statement: "Sign in to BountyCam. This proves you control this wallet and moves no funds.",
    version: "1",
    chainId: "devnet",
    nonce: "00112233445566778899aabbccddeeff",
    issuedAt: "2026-09-12T00:00:00.000Z",
    expirationTime: "2026-09-12T00:05:00.000Z",
  });
  const bytes = Buffer.from(message, "utf8");
  const sig = signBytes(seed, bytes).toString("hex");
  const want =
    "4460a95adf3394e0da7b738f0dca6a0eac57607cb4d88dc9ce4348d10cee24fd" +
    "e4d333ccb5bf192280d0aa57e88e5405b4ed20a5dec3eb122e6ad22efae26c09";
  console.log(`self-test: message ${bytes.length} bytes (AUTH.md: 333)`);
  console.log(`self-test: signature ${sig === want ? "MATCHES" : "DIFFERS FROM"} AUTH.md 12`);
  process.exit(bytes.length === 333 && sig === want ? 0 : 1);
}

async function call(method, path, token, body) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

function show(label, r) {
  const body = r.text.length > 600 ? r.text.slice(0, 600) + " …" : r.text;
  console.log(`${label}: HTTP ${r.status} ${body}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") return selfTest();
  const bountyId = args[0];
  if (bountyId === undefined || !/^[0-9a-f-]{36}$/.test(bountyId)) {
    console.error("usage: node apps/api/scripts/scout-race.mjs <bounty-id> | --self-test");
    process.exit(2);
  }

  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = loadWeb3();
  const secret = Uint8Array.from(JSON.parse(readFileSync(KEY_FILE, "utf8")));
  const keypair = Keypair.fromSecretKey(secret);
  const scout = keypair.publicKey;
  console.log(`scout: ${scout.toBase58()}`);

  // Sign in (AUTH.md section 5).
  const challenge = await call("POST", "/auth/siws/challenge", undefined, {
    address: scout.toBase58(),
  });
  if (challenge.status !== 200) return show("challenge", challenge);
  const message = Buffer.from(createSignInMessageText(challenge.json.input), "utf8");
  const verified = await call("POST", "/auth/siws/verify", undefined, {
    signed_message: message.toString("base64"),
    signature: signBytes(secret.slice(0, 32), message).toString("base64"),
  });
  if (verified.status !== 200) return show("verify", verified);
  const token = verified.json.token;
  console.log(`signed in as ${verified.json.user.wallet_address}`);

  // The public view, as the phone reads it before Accept.
  const detail = await call("GET", `/bounties/${bountyId}`, token);
  if (detail.status !== 200) return show("detail", detail);
  const view = detail.json;
  console.log(`bounty: ${view.title} · ${view.state} · account ${view.program_account}`);

  // The race.
  for (const n of ["3", "2", "1"]) {
    console.log(n);
    await sleep(1000);
  }
  console.log("GO");
  const sentAt = Date.now();
  const voucher = await call("POST", `/bounties/${bountyId}/voucher`, token);
  console.log(`voucher request sent at ${new Date(sentAt).toISOString()}`);
  show("voucher", voucher);
  if (voucher.status !== 200) {
    console.log("result: this Scout did not win the reservation");
    return;
  }

  // The winner accepts, with the phone's checks (DISCOVERY.md 3.3 steps 4 to 6).
  const v = voucher.json;
  const decoded = {
    message: Uint8Array.from(Buffer.from(v.message, "base64")),
    signature: Uint8Array.from(Buffer.from(v.signature, "base64")),
    authority: new PublicKey(v.authority).toBytes(),
    expiresAt: BigInt(v.expires_at),
  };
  const profile = ELIGIBILITY_PROFILES.get(view.policy_public.eligibility_profile_id);
  checkVoucher(decoded, {
    programId: new PublicKey(PROGRAM_ID).toBytes(),
    deploymentId: DEPLOYMENT_ID,
    bountyId: uuidBytes(bountyId),
    scout: scout.toBytes(),
    policyHash: Uint8Array.from(Buffer.from(view.policy_hash, "hex")),
    eligibilityProfileHash: eligibilityProfileHash(profile),
    requiredAssurance: view.policy_public.required_assurance,
    authority: new PublicKey(ELIGIBILITY_AUTHORITY).toBytes(),
  });
  console.log("voucher checked");
  const config = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    new PublicKey(PROGRAM_ID),
  )[0];
  if (config.toBase58() !== CONFIG_ACCOUNT) throw new Error("config derivation differs");
  const expected = {
    programId: new PublicKey(PROGRAM_ID).toBytes(),
    scout: scout.toBytes(),
    config: config.toBytes(),
    bounty: new PublicKey(view.program_account).toBytes(),
    authority: decoded.authority,
    signature: decoded.signature,
    message: decoded.message,
    expiresAt: decoded.expiresAt,
  };
  const connection = new Connection(RPC, "confirmed");
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: scout, blockhash, lastValidBlockHeight });
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(ED25519_PROGRAM_ID),
      keys: [],
      data: Buffer.from(
        ed25519InstructionData(decoded.authority, decoded.signature, decoded.message),
      ),
    }),
    new TransactionInstruction({
      programId: new PublicKey(PROGRAM_ID),
      keys: expectedAcceptKeys(expected).map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Buffer.from(acceptData(decoded.expiresAt, 0)),
    }),
  );
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const back = Transaction.from(wire);
  checkAcceptInstructions(
    back.instructions.map((ix) => ({
      programId: ix.programId.toBytes(),
      keys: ix.keys.map((k) => ({
        pubkey: k.pubkey.toBytes(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: Uint8Array.from(ix.data),
    })),
    expected,
  );
  if (!back.feePayer.equals(scout)) throw new Error("fee payer is not the Scout");
  console.log(`transaction checked: two instructions, ${wire.length} bytes`);
  back.sign(keypair);
  const signature = await connection.sendRawTransaction(back.serialize());
  console.log(`signature: ${signature}`);
  console.log(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  console.log(`confirmed: err ${JSON.stringify(confirmation.value.err)}`);
  show("report", await call("POST", `/bounties/${bountyId}/acceptance`, token));
  console.log("result: this Scout won the reservation");
}

main().catch((error) => {
  console.error("ERROR: " + (error?.code ? error.code + ": " : "") + error?.message);
  process.exit(1);
});
