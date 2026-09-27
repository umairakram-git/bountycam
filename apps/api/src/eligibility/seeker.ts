// ELIGIBILITY.md sections 5.1 and 5.3: the Seeker Genesis Token check, over
// Helius's getTokenAccountsByOwnerV2 on mainnet. Plain JSON-RPC over the
// injected fetch, as chain/rpc.ts. Any failure to complete the check throws,
// which the route answers SEEKER_CHECK_UNAVAILABLE; only a completed walk that
// finds nothing returns null. The endpoint URL carries the provider key, so no
// error message contains it, and nothing here logs.
import type { FetchLike } from "../chain/rpc.ts";
import type { Clock } from "../clock.ts";
import type { SeekerCheck } from "./deps.ts";

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Section 5.1's table, from Solana Mobile's developer documentation. The
// metadata and group addresses are deliberately the same value.
export const SGT_MINT_AUTHORITY = "GT2zuHVaZQYZSyQMgJPLzvkmyztfyXg2NJunqFp4p3A4";
export const SGT_METADATA_ADDRESS = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";
export const SGT_GROUP_ADDRESS = "GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te";

// Section 5.3: the startup guard. Any other cluster answers every walk with an
// empty wallet, the false "no Seeker" the section exists to prevent.
export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export const SEEKER_CACHE_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;
const MINT_BATCH = 100; // the getMultipleAccounts ceiling

export class SeekerCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeekerCheckError";
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown, what: string): Obj {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SeekerCheckError(what + " is not an object");
  }
  return value as Obj;
}

function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new SeekerCheckError(what + " is not an array");
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new SeekerCheckError(what + " is not a string");
  return value;
}

async function rpcResult(
  url: string,
  fetchImpl: FetchLike,
  method: string,
  params: unknown[],
): Promise<unknown> {
  let response: { ok: boolean; status: number; text(): Promise<string> };
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    throw new SeekerCheckError(method + " request failed before a response");
  }
  if (!response.ok) {
    throw new SeekerCheckError(method + " responded with HTTP " + response.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw new SeekerCheckError(method + " response is not JSON");
  }
  const body = obj(parsed, method + " response");
  if (body["error"] !== undefined) throw new SeekerCheckError(method + " returned an error");
  if (!("result" in body)) throw new SeekerCheckError(method + " response has no result");
  return body["result"];
}

export async function assertMainnet(url: string, fetchImpl: FetchLike): Promise<void> {
  const hash = await rpcResult(url, fetchImpl, "getGenesisHash", []);
  if (hash !== MAINNET_GENESIS_HASH) {
    throw new SeekerCheckError("SEEKER_RPC_URL is not a mainnet-beta endpoint");
  }
}

// Every Token-2022 mint the wallet holds at a non-zero balance, sorted, so a
// wallet holding two qualifying tokens resolves to the same one every time.
async function heldMints(url: string, fetchImpl: FetchLike, wallet: string): Promise<string[]> {
  const mints = new Set<string>();
  let paginationKey: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const options: Obj = { encoding: "jsonParsed", limit: PAGE_LIMIT };
    if (paginationKey !== null) options["paginationKey"] = paginationKey;
    const result = await rpcResult(url, fetchImpl, "getTokenAccountsByOwnerV2", [
      wallet,
      { programId: TOKEN_2022_PROGRAM },
      options,
    ]);
    // Nested under value, not the flat shape of Helius's own example (Session 14).
    const value = obj(obj(result, "result")["value"], "result.value");
    for (const entry of arr(value["accounts"], "result.value.accounts")) {
      const account = obj(obj(entry, "account entry")["account"], "account");
      if (account["owner"] !== TOKEN_2022_PROGRAM) {
        throw new SeekerCheckError("token account is not owned by Token-2022");
      }
      const parsed = obj(obj(account["data"], "account data")["parsed"], "account parsed");
      const info = obj(parsed["info"], "account info");
      if (info["owner"] !== wallet) {
        throw new SeekerCheckError("token account owner is not the wallet");
      }
      const amount = str(obj(info["tokenAmount"], "tokenAmount")["amount"], "tokenAmount.amount");
      if (!/^[0-9]+$/.test(amount)) {
        throw new SeekerCheckError("tokenAmount.amount is not an integer");
      }
      // Section 5.1: only a non-zero balance is current ownership. The account's
      // state is not read — the account holding a Seeker Genesis Token is frozen.
      if (BigInt(amount) === 0n) continue;
      mints.add(str(info["mint"], "account mint"));
    }
    const next = value["paginationKey"];
    if (next === null || next === undefined) return [...mints].sort();
    paginationKey = str(next, "result.value.paginationKey");
  }
  throw new SeekerCheckError("token accounts exceed the page bound");
}

// Section 5.1's three conditions. The group is read from tokenGroupMember, never
// from groupMemberPointer, whose memberAddress is the mint itself (Session 14).
function isSeekerMint(value: unknown): boolean {
  if (value === null) return false;
  const account = obj(value, "mint account");
  if (account["owner"] !== TOKEN_2022_PROGRAM) return false;
  const parsed = obj(obj(account["data"], "mint data")["parsed"], "mint parsed");
  if (parsed["type"] !== "mint") return false;
  const info = obj(parsed["info"], "mint info");
  if (info["mintAuthority"] !== SGT_MINT_AUTHORITY) return false;
  const rawExtensions = info["extensions"];
  const extensions = rawExtensions === undefined ? [] : arr(rawExtensions, "extensions");
  let pointer = false;
  let member = false;
  for (const item of extensions) {
    const extension = obj(item, "extension");
    const rawState = extension["state"];
    const state = rawState === undefined ? {} : obj(rawState, "extension state");
    if (extension["extension"] === "metadataPointer") {
      pointer =
        state["authority"] === SGT_MINT_AUTHORITY &&
        state["metadataAddress"] === SGT_METADATA_ADDRESS;
    }
    if (extension["extension"] === "tokenGroupMember") {
      member = state["group"] === SGT_GROUP_ADDRESS;
    }
  }
  return pointer && member;
}

// Section 5.3's cache holds found mints only. A "no" is not cached: it would
// keep refusing a Scout for a day after they move their token in, and the
// refusal path is not the one Scouts race on.
export function heliusSeekerCheck(url: string, fetchImpl: FetchLike, clock: Clock): SeekerCheck {
  const cache = new Map<string, { mint: string; checkedAt: number }>();
  return {
    async findSeekerMint(wallet: string): Promise<string | null> {
      const now = clock.now().getTime();
      const hit = cache.get(wallet);
      if (hit !== undefined) {
        if (now - hit.checkedAt < SEEKER_CACHE_MS) return hit.mint;
        cache.delete(wallet);
      }
      const mints = await heldMints(url, fetchImpl, wallet);
      for (let i = 0; i < mints.length; i += MINT_BATCH) {
        const batch = mints.slice(i, i + MINT_BATCH);
        const result = await rpcResult(url, fetchImpl, "getMultipleAccounts", [
          batch,
          { encoding: "jsonParsed" },
        ]);
        const values = arr(obj(result, "result")["value"], "result.value");
        if (values.length !== batch.length) {
          throw new SeekerCheckError("getMultipleAccounts returned the wrong count");
        }
        for (let j = 0; j < batch.length; j++) {
          const mint = batch[j];
          if (mint !== undefined && isSeekerMint(values[j])) {
            cache.set(wallet, { mint, checkedAt: now });
            return mint;
          }
        }
      }
      return null;
    },
  };
}
