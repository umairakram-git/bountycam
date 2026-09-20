// ELIGIBILITY.md section 3: the bounty account is read from the chain at
// confirmed commitment. Plain JSON-RPC over fetch, no @solana/web3.js (its
// rpc-websockets dependency trips pnpm's build-script block). The endpoint URL
// may carry a provider key in its path, so no error message ever contains it,
// and nothing here logs.

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
