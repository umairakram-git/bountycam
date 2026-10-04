// ELIGIBILITY.md section 3: the bounty account is read from the chain at
// confirmed commitment. Plain JSON-RPC over fetch, no @solana/web3.js (its
// rpc-websockets dependency trips pnpm's build-script block). The endpoint URL
// may carry a provider key in its path, so no error message ever contains it,
// and nothing here logs.
import { base58 } from "@scure/base";

export interface AccountInfo {
  readonly owner: string; // base58, as the RPC returns it
  readonly data: Uint8Array;
}

export interface ChainReader {
  getAccount(address: string): Promise<AccountInfo | null>;
}

export type ChainErrorCode =
  | "RPC_UNREACHABLE"
  | "RPC_HTTP"
  | "RPC_MALFORMED"
  | "RPC_ERROR";

export class ChainError extends Error {
  readonly code: ChainErrorCode;

  constructor(code: ChainErrorCode, message: string) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}

// The subset of fetch the reader uses, so a test double is a plain function.
// The global fetch satisfies it.
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const malformed = (what: string): ChainError =>
  new ChainError("RPC_MALFORMED", "RPC response " + what);

export function jsonRpcChainReader(url: string, fetchImpl: FetchLike): ChainReader {
  return {
    async getAccount(address: string): Promise<AccountInfo | null> {
      let response: { ok: boolean; status: number; text(): Promise<string> };
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [address, { encoding: "base64", commitment: "confirmed" }],
          }),
        });
      } catch {
        throw new ChainError("RPC_UNREACHABLE", "RPC request failed before a response");
      }
      if (!response.ok) {
        throw new ChainError("RPC_HTTP", "RPC responded with HTTP " + response.status);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await response.text());
      } catch {
        throw malformed("is not JSON");
      }
      if (parsed === null || typeof parsed !== "object") throw malformed("is not an object");
      const body = parsed as { error?: unknown; result?: unknown };
      if (body.error !== undefined) {
        throw new ChainError("RPC_ERROR", "RPC returned an error object");
      }
      const result = body.result;
      if (result === null || typeof result !== "object" || !("value" in result)) {
        throw malformed("has no result.value");
      }
      const value = (result as { value: unknown }).value;
      if (value === null) return null;
      if (typeof value !== "object") throw malformed("value is not an object");
      const v = value as { owner?: unknown; data?: unknown };
      if (
        typeof v.owner !== "string" ||
        !Array.isArray(v.data) ||
        typeof v.data[0] !== "string" ||
        v.data[1] !== "base64"
      ) {
        throw malformed("value lacks a base58 owner and base64 data pair");
      }
      return { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], "base64")) };
    },
  };
}

// POLICY.md 19.9 (D151): the three calls the verifier makes to send and confirm a
// transaction, with the reader's error handling: no response body or URL in any error.
export interface SignatureStatus {
  readonly confirmationStatus: string | null;
  readonly failed: boolean;
}

export interface ChainWriter {
  getLatestBlockhash(): Promise<Uint8Array>;
  /** The transaction's signature, base58, as the RPC returns it. */
  sendTransaction(wire: Uint8Array): Promise<string>;
  /** One entry per signature; null where the RPC knows none. */
  getSignatureStatuses(signatures: readonly string[]): Promise<(SignatureStatus | null)[]>;
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
    throw new ChainError("RPC_UNREACHABLE", "RPC request failed before a response");
  }
  if (!response.ok) {
    throw new ChainError("RPC_HTTP", "RPC responded with HTTP " + response.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    throw malformed("is not JSON");
  }
  if (parsed === null || typeof parsed !== "object") throw malformed("is not an object");
  const body = parsed as { error?: unknown; result?: unknown };
  if (body.error !== undefined) {
    throw new ChainError("RPC_ERROR", "RPC returned an error object");
  }
  if (!("result" in body)) throw malformed("has no result");
  return body.result;
}

function decodeBlockhash(text: string): Uint8Array | null {
  try {
    const bytes = base58.decode(text);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function jsonRpcChainWriter(url: string, fetchImpl: FetchLike): ChainWriter {
  return {
    async getLatestBlockhash(): Promise<Uint8Array> {
      const result = await rpcResult(url, fetchImpl, "getLatestBlockhash", [
        { commitment: "confirmed" },
      ]);
      const value = (result as { value?: { blockhash?: unknown } } | null)?.value;
      const hash = typeof value?.blockhash === "string" ? decodeBlockhash(value.blockhash) : null;
      if (hash === null) throw malformed("value lacks a base58 blockhash");
      return hash;
    },
    async sendTransaction(wire: Uint8Array): Promise<string> {
      const result = await rpcResult(url, fetchImpl, "sendTransaction", [
        Buffer.from(wire).toString("base64"),
        { encoding: "base64", preflightCommitment: "confirmed" },
      ]);
      if (typeof result !== "string" || result.length === 0) {
        throw malformed("result is not a signature");
      }
      return result;
    },
    async getSignatureStatuses(signatures: readonly string[]) {
      const result = await rpcResult(url, fetchImpl, "getSignatureStatuses", [
        [...signatures],
        { searchTransactionHistory: true },
      ]);
      const value = (result as { value?: unknown } | null)?.value;
      if (!Array.isArray(value) || value.length !== signatures.length) {
        throw malformed("value is not one entry per signature");
      }
      return value.map((entry): SignatureStatus | null => {
        if (entry === null) return null;
        if (typeof entry !== "object") throw malformed("status is not an object");
        const e = entry as { confirmationStatus?: unknown; err?: unknown };
        return {
          confirmationStatus:
            typeof e.confirmationStatus === "string" ? e.confirmationStatus : null,
          failed: e.err !== null && e.err !== undefined,
        };
      });
    },
  };
}
