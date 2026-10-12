// D167: hand the test-USDC mint's authority from the upgrade authority to a dedicated faucet
// key, once. Run on the laptop, which alone holds the upgrade authority:
//
//   node apps/api/scripts/faucet-authority.mjs
//     [--upgrade-key ~/bountycam-keys/upgrade-authority.json]
//     [--faucet-key ~/bountycam-keys/faucet.json]
//     [--rpc https://api.devnet.solana.com] [--mint ADhRyy71...]
//
// It reads the mint, stops unless the upgrade authority is its current authority, creates
// the faucet key if the file does not exist (mode 600), shows the change and asks once, then
// sends one SPL Token SetAuthority (MintTokens) and re-reads the mint to confirm. Running it
// again after success only reports that the faucet key already holds the authority.
// Devnet only. Prints public keys and the signature, never a secret.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { randomBytes } from "node:crypto";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { jsonRpcChainWriter } from "../src/chain/rpc.ts";
import { legacyMessage, signedWire } from "../src/chain/tx.ts";
import { TOKEN_PROGRAM_ID } from "../src/chain/pda.ts";
import { mintAuthority } from "../src/faucet/config.ts";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const home = (p) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);
const upgradePath = home(opt("--upgrade-key", "~/bountycam-keys/upgrade-authority.json"));
const faucetPath = home(opt("--faucet-key", "~/bountycam-keys/faucet.json"));
const rpcUrl = opt("--rpc", "https://api.devnet.solana.com");
const mintAddress = opt("--mint", "ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR");

function stop(message) {
  console.log("STOP: " + message);
  process.exit(1);
}
if (rpcUrl.includes("mainnet")) stop("devnet only (D167)");

function readKey(path, name) {
  let bytes;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    stop(name + " could not be read: " + path);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) stop(name + " is not a 64-byte key file");
  const seed = Uint8Array.from(bytes.slice(0, 32));
  const pubkey = Uint8Array.from(bytes.slice(32));
  if (!Buffer.from(ed25519.getPublicKey(seed)).equals(Buffer.from(pubkey))) {
    stop(name + "'s public half does not match its seed");
  }
  return { seed, pubkey };
}

async function rpc(method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) stop(method + ": HTTP " + res.status);
  const body = await res.json();
  if (body.error !== undefined) stop(method + ": " + JSON.stringify(body.error));
  return body.result;
}

async function readAuthority() {
  const result = await rpc("getAccountInfo", [
    mintAddress,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  if (result?.value == null) stop("the mint account was not found on this cluster");
  if (result.value.owner !== TOKEN_PROGRAM_ID) stop("the mint is not an SPL Token mint");
  return mintAuthority(Uint8Array.from(Buffer.from(result.value.data[0], "base64")));
}

const eq = (a, b) => a !== null && Buffer.from(a).equals(Buffer.from(b));
const upgrade = readKey(upgradePath, "the upgrade authority key");
const current = await readAuthority();
console.log("mint:              " + mintAddress);
console.log("current authority: " + (current === null ? "(none)" : base58.encode(current)));

if (existsSync(faucetPath)) {
  const existing = readKey(faucetPath, "the faucet key");
  if (eq(current, existing.pubkey)) {
    console.log("Done already: the faucet key " + base58.encode(existing.pubkey) +
      " holds the mint authority.");
    process.exit(0);
  }
}
if (!eq(current, upgrade.pubkey)) {
  stop("the upgrade authority " + base58.encode(upgrade.pubkey) + " is not the mint authority");
}

let faucet;
if (existsSync(faucetPath)) {
  faucet = readKey(faucetPath, "the faucet key");
  console.log("faucet key:        " + base58.encode(faucet.pubkey) + " (existing file)");
} else {
  const seed = Uint8Array.from(randomBytes(32));
  faucet = { seed, pubkey: ed25519.getPublicKey(seed) };
  writeFileSync(faucetPath, JSON.stringify([...faucet.seed, ...faucet.pubkey]), { mode: 0o600 });
  chmodSync(faucetPath, 0o600);
  console.log("faucet key:        " + base58.encode(faucet.pubkey) + " (new, " + faucetPath + ")");
}
if (eq(faucet.pubkey, upgrade.pubkey)) stop("the faucet key must differ from the upgrade key");

const writer = jsonRpcChainWriter(rpcUrl, fetch);
const blockhash = await writer.getLatestBlockhash();
const mint = base58.decode(mintAddress);
const message = legacyMessage(upgrade.pubkey, [], [
  {
    programId: base58.decode(TOKEN_PROGRAM_ID), // SetAuthority, MintTokens, Some(faucet)
    accounts: [
      { key: mint, writable: true },
      { key: upgrade.pubkey, writable: false },
    ],
    data: Uint8Array.from([6, 0, 1, ...faucet.pubkey]),
  },
], blockhash);
const tx = signedWire(message, [upgrade.seed]);

console.log("\nThis sets the test mint's authority to the faucet key. The upgrade authority");
console.log("can no longer mint test USDC afterwards; the faucet key can, and nothing else.");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("Send the SetAuthority transaction? [y/N] ")).trim();
rl.close();
if (answer.toLowerCase() !== "y") stop("not sent");

await writer.sendTransaction(tx.wire);
console.log("sent: " + tx.signature);
for (let i = 0; i < 60; i++) {
  const [status] = await writer.getSignatureStatuses([tx.signature]);
  if (status?.failed) stop("the transaction failed on chain");
  if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
const after = await readAuthority();
if (!eq(after, faucet.pubkey)) stop("the mint authority did not change; check the signature");
console.log("Confirmed: the faucet key " + base58.encode(faucet.pubkey) +
  " is now the mint authority.");
console.log("https://explorer.solana.com/tx/" + tx.signature + "?cluster=devnet");
console.log("\nNext: add this line to ~/bountycam-env/api.env, and back up " + faucetPath + ":");
console.log("FAUCET_KEY_PATH=" + faucetPath);
