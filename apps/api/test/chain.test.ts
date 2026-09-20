import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ChainError, jsonRpcChainReader } from "../src/chain/rpc.ts";
import type { FetchLike } from "../src/chain/rpc.ts";
import {
  BOUNTY_DISCRIMINATOR,
  BOUNTY_FIXED_LENGTH,
  BOUNTY_MAX_LENGTH,
  decodeBountyAccount,
} from "../src/chain/bounty.ts";

const PROGRAM = "6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS";
const URL_WITH_KEY = "https://rpc.example.test/?api-key=SECRET-KEY-VALUE";

function respond(status: number, text: string): FetchLike {
  return async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });
}

function rpcResult(value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value } });
}

// A Funded bounty at the full 274 bytes: distinct fill per field, extreme
// numeric values, state 0, bump 254, Option tail all None.
function fundedAccount(length = BOUNTY_MAX_LENGTH): Uint8Array {
  const d = new Uint8Array(length);
  const v = new DataView(d.buffer);
  d.set(BOUNTY_DISCRIMINATOR, 0);
  d.fill(0x11, 8, 24);
  d.fill(0x22, 24, 56);
  v.setBigUint64(56, 18_446_744_073_709_551_615n, true);
  v.setBigUint64(64, 0n, true);
  d.fill(0x33, 72, 104);
  d.fill(0x44, 104, 136);
  v.setUint8(136, 4);
  v.setBigInt64(137, 2_592_000n, true);
  v.setBigInt64(145, 60n, true);
  v.setBigInt64(153, -1n, true);
  v.setBigInt64(161, -9_223_372_036_854_775_808n, true);
  v.setUint8(169, 0);
  v.setUint8(170, 254);
  return d;
}

function b64(d: Uint8Array): string {
  return Buffer.from(d).toString("base64");
}

test("01 reader sends one getAccountInfo request: base64, confirmed, POST, JSON", async () => {
  const calls: {
    input: string;
    init: { method: string; headers: Record<string, string>; body: string };
  }[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({ input, init });
    return { ok: true, status: 200, text: async () => rpcResult(null) };
  };
  await jsonRpcChainReader(URL_WITH_KEY, fetchImpl).getAccount(
    "So11111111111111111111111111111111111111112",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input, URL_WITH_KEY);
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [
      "So11111111111111111111111111111111111111112",
      { encoding: "base64", commitment: "confirmed" },
    ],
  });
});

test("02 a null value is returned as null, not an error", async () => {
  const reader = jsonRpcChainReader(URL_WITH_KEY, respond(200, rpcResult(null)));
  assert.equal(await reader.getAccount("x"), null);
});

test("03 owner and base64 data are decoded into an AccountInfo", async () => {
  const data = fundedAccount();
  const reader = jsonRpcChainReader(
    URL_WITH_KEY,
    respond(200, rpcResult({ owner: PROGRAM, data: [b64(data), "base64"], lamports: 1 })),
  );
  const info = await reader.getAccount("x");
  assert.ok(info !== null);
  assert.equal(info.owner, PROGRAM);
  assert.deepEqual(info.data, data);
});

test("04 each failure mode pins its ChainError code", async () => {
  const cases: [string, FetchLike][] = [
    ["RPC_UNREACHABLE", async () => { throw new Error("ECONNREFUSED"); }],
    ["RPC_HTTP", respond(500, "")],
    ["RPC_HTTP", respond(429, rpcResult(null))],
    ["RPC_MALFORMED", respond(200, "<html>")],
    ["RPC_MALFORMED", respond(200, JSON.stringify({ jsonrpc: "2.0", id: 1 }))],
    ["RPC_MALFORMED", respond(200, rpcResult({ owner: PROGRAM }))],
    ["RPC_MALFORMED", respond(200, rpcResult({ owner: PROGRAM, data: ["AA==", "base58"] }))],
    ["RPC_MALFORMED", respond(200, rpcResult({ owner: 5, data: ["AA==", "base64"] }))],
    ["RPC_ERROR", respond(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602 } }))],
  ];
  for (const [code, fetchImpl] of cases) {
    await assert.rejects(
      jsonRpcChainReader(URL_WITH_KEY, fetchImpl).getAccount("x"),
      (e: unknown) => e instanceof ChainError && e.code === code,
      code,
    );
  }
});

test("05 no ChainError message contains the endpoint URL or its key", async () => {
  const cases: FetchLike[] = [
    async () => { throw new Error(URL_WITH_KEY); },
    respond(503, URL_WITH_KEY),
    respond(200, URL_WITH_KEY),
    respond(200, JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: URL_WITH_KEY } })),
  ];
  for (const fetchImpl of cases) {
    try {
      await jsonRpcChainReader(URL_WITH_KEY, fetchImpl).getAccount("x");
      assert.fail("expected a ChainError");
    } catch (e) {
      assert.ok(e instanceof ChainError);
      assert.ok(!e.message.includes("SECRET-KEY-VALUE"));
      assert.ok(!e.message.includes("rpc.example.test"));
    }
  }
});

test("06 the Bounty discriminator is sha256 of account:Bounty, first eight bytes", () => {
  const expected = createHash("sha256").update("account:Bounty").digest().subarray(0, 8);
  assert.deepEqual(Buffer.from(BOUNTY_DISCRIMINATOR), expected);
  assert.equal(BOUNTY_FIXED_LENGTH, 171);
  assert.equal(BOUNTY_MAX_LENGTH, 274);
});

test("07 a Funded account decodes every fixed field at both length bounds", () => {
  for (const length of [BOUNTY_FIXED_LENGTH, BOUNTY_MAX_LENGTH]) {
    const r = decodeBountyAccount({ owner: PROGRAM, data: fundedAccount(length) }, PROGRAM);
    assert.ok(r.ok, String(length));
    const b = r.bounty;
    assert.deepEqual(b.bountyId, new Uint8Array(16).fill(0x11));
    assert.deepEqual(b.requester, new Uint8Array(32).fill(0x22));
    assert.equal(b.rewardAmount, 18_446_744_073_709_551_615n);
    assert.equal(b.platformFee, 0n);
    assert.deepEqual(b.policyHash, new Uint8Array(32).fill(0x33));
    assert.deepEqual(b.eligibilityProfileHash, new Uint8Array(32).fill(0x44));
    assert.equal(b.requiredAssurance, 4);
    assert.equal(b.acceptanceWindowSecs, 2_592_000n);
    assert.equal(b.completionWindowSecs, 60n);
    assert.equal(b.reviewWindowSecs, -1n);
    assert.equal(b.acceptanceCutoff, -9_223_372_036_854_775_808n);
    assert.equal(b.state, "Funded");
    assert.equal(b.bump, 254);
  }
});

test("08 decode rejections pin their code, in check order", () => {
  const good = fundedAccount();
  const err = (info: { owner: string; data: Uint8Array }): string =>
    (decodeBountyAccount(info, PROGRAM) as { ok: false; error: string }).error;
  assert.equal(
    err({ owner: "11111111111111111111111111111111", data: good }),
    "NOT_PROGRAM_ACCOUNT",
  );
  assert.equal(err({ owner: PROGRAM, data: good.slice(0, 170) }), "BAD_LENGTH");
  assert.equal(err({ owner: PROGRAM, data: new Uint8Array(275) }), "BAD_LENGTH");
  const badDisc = fundedAccount();
  badDisc[0] = 0x00;
  assert.equal(err({ owner: PROGRAM, data: badDisc }), "BAD_DISCRIMINATOR");
  for (const s of [1, 5]) {
    const acc = fundedAccount();
    acc[169] = s;
    assert.ok(decodeBountyAccount({ owner: PROGRAM, data: acc }, PROGRAM).ok, String(s));
  }
  const badState = fundedAccount();
  badState[169] = 6;
  assert.equal(err({ owner: PROGRAM, data: badState }), "BAD_STATE");
  const both = fundedAccount();
  both[0] = 0x00;
  assert.equal(
    err({ owner: "11111111111111111111111111111111", data: both }),
    "NOT_PROGRAM_ACCOUNT",
  );
});
