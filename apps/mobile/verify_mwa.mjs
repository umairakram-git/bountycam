// MWA spike Q2 verifier — @noble/curves 2.4.0 from apps/api.
// Usage: node /tmp/verify_mwa.mjs <pubkey_base58> <message_base64> <result_base64>
import { ed25519 } from '/Users/umairakram/Developer/hackathon202609/apps/api/node_modules/@noble/curves/ed25519.js';
import { base58 } from '/Users/umairakram/Developer/hackathon202609/apps/api/node_modules/@scure/base/index.js';

const [pubkeyB58, messageB64, resultB64] = process.argv.slice(2);
if (!pubkeyB58 || !messageB64 || !resultB64) {
  console.error('usage: node verify_mwa.mjs <pubkey_base58> <message_base64> <result_base64>');
  process.exit(2);
}

const pubkey = base58.decode(pubkeyB58);
const message = Buffer.from(messageB64, 'base64');
const result = Buffer.from(resultB64, 'base64');

console.log(`pubkey bytes:  ${pubkey.length}`);
console.log(`message bytes: ${message.length}`);
console.log(`result bytes:  ${result.length}`);

const tryVerify = (label, sig, msg) => {
  if (sig.length !== 64) return console.log(`${label}: skipped (sig ${sig.length} bytes, need 64)`);
  let ok = false;
  try {
    ok = ed25519.verify(sig, msg, pubkey);
  } catch (e) {
    return console.log(`${label}: threw ${String(e)}`);
  }
  console.log(`${label}: ${ok ? 'VERIFIED' : 'failed'}`);
};

// Candidate interpretations of the wallet's returned bytes:
tryVerify('bare 64-byte signature over message', result, message);
if (result.length === message.length + 64) {
  tryVerify('sig-prefixed (first 64) over message', result.subarray(0, 64), message);
  tryVerify('sig-suffixed (last 64) over message', result.subarray(result.length - 64), message);
}
if (result.length > 64 && result.length !== message.length + 64) {
  tryVerify('first 64 of result over message', result.subarray(0, 64), message);
  tryVerify('last 64 of result over message', result.subarray(result.length - 64), message);
}
