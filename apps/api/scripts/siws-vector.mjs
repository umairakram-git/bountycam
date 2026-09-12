// Reproduction script for the worked vector in apps/api/AUTH.md section 12.
// TEST KEY ONLY: the seed is RFC 8032 section 7.1 TEST 1, a published key.
// Not used by the app — run manually to re-derive the vector.
// ed25519 oracle: node:crypto (Node 22). Asserts against BOTH published
// TEST 1 values (public key, empty-message signature); exits 1 on mismatch.
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// RFC 8032 section 7.1 TEST 1 values, from the RFC text at rfc-editor.org
// (not from memory)
const seed = Buffer.from(
  '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex');
const rfcPublicKey =
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const rfcEmptyMsgSignature =
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
  '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';

// PKCS8 wrapper around a raw ed25519 seed; validity is proven by the two
// RFC assertions below, not trusted.
const pkcs8 = Buffer.concat(
  [Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const priv = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const pub = createPublicKey(priv);
const spki = pub.export({ format: 'der', type: 'spki' });
const pubRaw = spki.subarray(spki.length - 32);

if (pubRaw.toString('hex') !== rfcPublicKey) {
  console.error('FAIL: derived public key does not match RFC 8032 TEST 1');
  console.error('derived: ', pubRaw.toString('hex'));
  console.error('expected:', rfcPublicKey);
  process.exit(1);
}

// RFC 8032 TEST 1 signs the empty message; ed25519 is deterministic, so
// the signature must match the published bytes exactly.
const emptySig = sign(null, Buffer.alloc(0), priv);
if (emptySig.toString('hex') !== rfcEmptyMsgSignature) {
  console.error('FAIL: empty-message signature does not match RFC 8032 TEST 1');
  console.error('derived: ', emptySig.toString('hex'));
  console.error('expected:', rfcEmptyMsgSignature);
  process.exit(1);
}
console.log('RFC 8032 TEST 1 public key:  MATCH');
console.log('RFC 8032 TEST 1 signature:   MATCH');

// base58, Bitcoin alphabet
const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(buf) {
  let n = BigInt('0x' + buf.toString('hex'));
  let s = '';
  while (n > 0n) { s = ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
const address = b58(pubRaw);

// Message built following createSignInMessageText, quoted from
// @solana/wallet-standard-util 1.1.2 src/signIn.ts (== commit dbb6a98):
// domain line, address, blank line + statement, blank line + fields.
const domain = 'app.example.com'; // placeholder — item e OPEN (Session 10)
const statement = 'Sign in to BountyCam';
const nonce = '00112233445566778899aabbccddeeff';
const issuedAt = '2026-09-12T00:00:00.000Z';
const expirationTime = '2026-09-12T00:05:00.000Z';

let message = `${domain} wants you to sign in with your Solana account:\n`;
message += `${address}`;
message += `\n\n${statement}`;
const fields = [
  `Version: 1`,
  `Chain ID: devnet`,
  `Nonce: ${nonce}`,
  `Issued At: ${issuedAt}`,
  `Expiration Time: ${expirationTime}`,
];
message += `\n\n${fields.join('\n')}`;

const msgBytes = Buffer.from(message, 'utf8');
const sig = sign(null, msgBytes, priv);
const ok = verify(null, msgBytes, pub, sig);
if (!ok) {
  console.error('FAIL: self-verify failed');
  process.exit(1);
}

console.log('seed (hex):            ' + seed.toString('hex'));
console.log('public key (hex):      ' + pubRaw.toString('hex'));
console.log('address (base58):      ' + address);
console.log('--- message text (between markers) ---');
console.log(message);
console.log('--- end message ---');
console.log('message length (bytes): ' + msgBytes.length);
console.log('message (base64):      ' + msgBytes.toString('base64'));
console.log('signature (hex):       ' + sig.toString('hex'));
console.log('signature (base64):    ' + sig.toString('base64'));
console.log('self-verify:           ' + ok);
