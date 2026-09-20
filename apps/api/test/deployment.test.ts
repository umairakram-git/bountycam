import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58 } from "@scure/base";
import { loadEligibilityConfig } from "../src/chain/config.ts";
import type { EligibilityConfig } from "../src/chain/config.ts";
import {
  CONFIG_DISCRIMINATOR,
  CONFIG_LENGTH,
  DeploymentError,
  resolveDeployment,
} from "../src/chain/deployment.ts";
import type { AccountInfo, ChainReader } from "../src/chain/rpc.ts";
import { eligibilitySigner } from "../src/chain/signer.ts";

// The published test key: seed and public key from packages/shared vectors.
// A test value only; never a live authority (MESSAGES.md section 8).
const vectors = JSON.parse(
  readFileSync(
    join(process.cwd(), "..", "..", "packages", "shared", "vectors", "vectors.json"),
    "utf8",
  ),
) as {
  authorities: { eligibility_seed_ascii: string; eligibility_pubkey_hex: string };
  vectors: { name: string; message_len: number; message_hex: string; signature_hex: string }[];
};
const SEED = Uint8Array.from(Buffer.from(vectors.authorities.eligibility_seed_ascii, "ascii"));
const PUBKEY = Uint8Array.from(Buffer.from(vectors.authorities.eligibility_pubkey_hex, "hex"));
const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const CONFIG_ACCOUNT = "DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb";
const ZERO32 = "11111111111111111111111111111111";

const dir = mkdtempSync(join(tmpdir(), "bountycam-deployment-test-"));
function keyFile(name: string, bytes: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof bytes === "string" ? bytes : JSON.stringify(bytes));
  return path;
}
const goodKeyPath = keyFile("good.json", Array.from([...SEED, ...PUBKEY]));

const baseEnv: Record<string, string> = {
  SOLANA_RPC_URL: "https://rpc.example.test/?api-key=SECRET-KEY-VALUE",
  ESCROW_PROGRAM_ID: PROGRAM,
  ESCROW_CONFIG_ACCOUNT: CONFIG_ACCOUNT,
  ELIGIBILITY_KEY_PATH: goodKeyPath,
};
const config = (): EligibilityConfig => loadEligibilityConfig(baseEnv);

// A Config account: deployment_id 2, usdc_mint all zero (ZERO32), the
// published test key as eligibility_authority, arbitrary attester and
// arbiter, bump 255.
function configAccount(): Uint8Array {
  const d = new Uint8Array(CONFIG_LENGTH);
  d.set(CONFIG_DISCRIMINATOR, 0);
  d[8] = 2;
  d.set(PUBKEY, 41);
  d.fill(0x77, 73, 105);
  d.fill(0x88, 105, 137);
  d[137] = 255;
  return d;
}

function readerOf(value: AccountInfo | null, seen: string[] = []): ChainReader {
  return {
    async getAccount(address) {
      seen.push(address);
      return value;
    },
  };
}

test("01 valid environment loads: program id bytes, key seed and public key", () => {
  const c = config();
  assert.equal(c.rpcUrl, baseEnv["SOLANA_RPC_URL"]);
  assert.equal(c.programId, PROGRAM);
  assert.deepEqual(c.programIdBytes, base58.decode(PROGRAM));
  assert.equal(c.programIdBytes.length, 32);
  assert.equal(c.configAccount, CONFIG_ACCOUNT);
  assert.deepEqual(c.keySeed, SEED);
  assert.deepEqual(c.keyPubkey, PUBKEY);
});

test("02 each missing variable names itself; malformed values are rejected", () => {
  for (const name of Object.keys(baseEnv)) {
    const env = { ...baseEnv };
    delete env[name];
    assert.throws(() => loadEligibilityConfig(env), (e: unknown) =>
      e instanceof Error && e.message.includes(name), name);
    assert.throws(() => loadEligibilityConfig({ ...baseEnv, [name]: "" }), name + " empty");
  }
  assert.throws(() => loadEligibilityConfig({ ...baseEnv, SOLANA_RPC_URL: "http://x" }));
  assert.throws(() => loadEligibilityConfig({ ...baseEnv, ESCROW_PROGRAM_ID: "abc" }));
  assert.throws(() => loadEligibilityConfig({ ...baseEnv, ESCROW_CONFIG_ACCOUNT: "0OIl" }));
});

test("03 key file faults are rejected and never echoed", () => {
  const bad: [string, string][] = [
    ["not-json.json", keyFile("not-json.json", "{")],
    ["short.json", keyFile("short.json", Array.from([...SEED, ...PUBKEY]).slice(0, 63))],
    ["range.json", keyFile("range.json", [...Array.from([...SEED, ...PUBKEY]).slice(0, 63), 256])],
    ["mismatch.json", keyFile("mismatch.json", Array.from([...SEED, ...new Uint8Array(32)]))],
    ["missing.json", join(dir, "does-not-exist.json")],
  ];
  for (const [label, path] of bad) {
    assert.throws(
      () => loadEligibilityConfig({ ...baseEnv, ELIGIBILITY_KEY_PATH: path }),
      (e: unknown) =>
        e instanceof Error &&
        !e.message.includes(vectors.authorities.eligibility_seed_ascii) &&
        !e.message.includes(String(SEED[0])),
      label,
    );
  }
});

test("04 signer reproduces every published voucher signature from the seed", () => {
  const signer = eligibilitySigner(config().keySeed);
  assert.deepEqual(signer.pubkey, PUBKEY);
  const vouchers = vectors.vectors.filter((v) => v.message_len === 212);
  assert.equal(vouchers.length, 4);
  for (const v of vouchers) {
    const sig = signer.sign(Uint8Array.from(Buffer.from(v.message_hex, "hex")));
    assert.equal(Buffer.from(sig).toString("hex"), v.signature_hex, v.name);
  }
  assert.throws(() => eligibilitySigner(new Uint8Array(31)));
});

test("05 resolveDeployment reads the configured account once and returns its facts", async () => {
  const seen: string[] = [];
  const reader = readerOf({ owner: PROGRAM, data: configAccount() }, seen);
  const dep = await resolveDeployment(reader, config(), ZERO32);
  assert.deepEqual(seen, [CONFIG_ACCOUNT]);
  assert.equal(dep.deploymentId, 2);
  assert.deepEqual(dep.usdcMint, new Uint8Array(32));
  assert.deepEqual(dep.eligibilityAuthority, PUBKEY);
});

test("06 each deployment fault pins its code, in check order", async () => {
  const code = async (info: AccountInfo | null, mint = ZERO32): Promise<string> => {
    try {
      await resolveDeployment(readerOf(info), config(), mint);
      return "OK";
    } catch (e) {
      assert.ok(e instanceof DeploymentError);
      return e.code;
    }
  };
  const good = configAccount();
  assert.equal(await code(null), "CONFIG_ACCOUNT_MISSING");
  assert.equal(await code({ owner: ZERO32, data: good }), "CONFIG_NOT_PROGRAM_ACCOUNT");
  assert.equal(await code({ owner: PROGRAM, data: good.slice(0, 137) }), "CONFIG_BAD_LENGTH");
  assert.equal(await code({ owner: PROGRAM, data: new Uint8Array(139) }), "CONFIG_BAD_LENGTH");
  const badDisc = configAccount();
  badDisc[0] = 0;
  assert.equal(await code({ owner: PROGRAM, data: badDisc }), "CONFIG_BAD_DISCRIMINATOR");
  const badAuth = configAccount();
  badAuth[41] ^= 0x01;
  assert.equal(await code({ owner: PROGRAM, data: badAuth }), "ELIGIBILITY_AUTHORITY_MISMATCH");
  const badMint = configAccount();
  badMint[9] = 1;
  assert.equal(await code({ owner: PROGRAM, data: badMint }), "SETTLEMENT_MINT_MISMATCH");
  assert.equal(await code({ owner: PROGRAM, data: good }, PROGRAM), "SETTLEMENT_MINT_MISMATCH");
  const both = configAccount();
  both[0] = 0;
  assert.equal(await code({ owner: ZERO32, data: both }), "CONFIG_NOT_PROGRAM_ACCOUNT");
});

test("07 deployment error messages carry no key bytes or account data", async () => {
  const badAuth = configAccount();
  badAuth[41] ^= 0x01;
  try {
    await resolveDeployment(readerOf({ owner: PROGRAM, data: badAuth }), config(), ZERO32);
    assert.fail("expected DeploymentError");
  } catch (e) {
    assert.ok(e instanceof DeploymentError);
    assert.ok(!e.message.includes(Buffer.from(PUBKEY).toString("hex")));
    assert.ok(!e.message.includes(vectors.authorities.eligibility_seed_ascii));
    assert.ok(e.message.length < 120);
  }
});
