import { base58 } from "@scure/base";

// One point of truth for the 32-byte base58 key form (POLICY.md sections 6.3
// and 8.1). Decode-and-measure, never a length heuristic on the string.
export function isBase58For32Bytes(value: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(value);
  } catch {
    return false;
  }
  return bytes.length === 32;
}
