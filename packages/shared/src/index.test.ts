import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalise, sha256, merkleRoot } from "./index.js";

test("canonicalise sorts keys and serialises numbers as strings", () => {
  assert.equal(canonicalise({ b: 2, a: 1 }), '{"a":"1","b":"2"}');
});

test("sha256 returns the 32-byte digest", () => {
  const digest = sha256(new Uint8Array([1, 2, 3]));
  assert.equal(digest.length, 32);
});

test("merkleRoot returns the 32-byte root", () => {
  const root = merkleRoot([new Uint8Array(32), new Uint8Array(32)]);
  assert.equal(root.length, 32);
});
