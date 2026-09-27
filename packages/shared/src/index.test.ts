import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  canonicalise,
  sha256,
  merkleRoot,
  SpecError,
  eligibilityProfileHash,
  eligibilityMessage,
  ELIGIBILITY_DOMAIN_TAG,
  ELIGIBILITY_SCHEMA_VERSION,
  ELIGIBILITY_MESSAGE_LENGTH,
  MAX_ASSURANCE_LEVEL,
  isValidLat,
  isValidLon,
  gpsToScaled,
  formatCoordinate,
  parseCoordinatePair,
  ELIGIBILITY_PROFILES,
  admissibleProfileId,
  uuidBytes,
  createAndFundData,
  CREATE_AND_FUND_DISCRIMINATOR,
  verifyCreatedBounty,
  decimalToBaseUnits,
  checkFundingInstructions,
  expectedFundingKeys,
} from "./index.js";
import type {
  CreatedBountyExpectation,
  EligibilityMessageFields,
  EligibilityProfile,
  ExpectedFunding,
  FundingArgs,
  PlainAccountMeta,
  PlainInstruction,
} from "./index.js";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const rejectsWith = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SpecError, "expected SpecError, got: " + String(err));
    assert.equal(err.code, code);
    return;
  }
  assert.fail("expected SpecError with code " + code + ", but nothing was thrown");
};

// Characters used in test data are built from explicit code points, never
// written as literal escape sequences in data (D31).
const EACUTE = String.fromCodePoint(0x00e9); // U+00E9
const KANGAROO = String.fromCodePoint(0x1f998); // U+1F998 (non-BMP)
const NL = String.fromCharCode(0x000a); // U+000A
const BS = String.fromCharCode(0x005c); // U+005C reverse solidus
const FEFF = String.fromCharCode(0xfeff); // U+FEFF

const nested = (depth: number): unknown => {
  let v: unknown = 0;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};

// Builds a cycle of exactly n distinct arrays: the first array, then n - 1
// more created in the loop, each nested in the previous; the innermost links
// back to the first. From the top level the ancestor is re-entered at depth
// n + 1 (SPEC.md section 6.3).
const cycleFromTop = (n: number): unknown => {
  const first: unknown[] = [];
  let current = first;
  for (let i = 1; i < n; i++) {
    const next: unknown[] = [];
    current.push(next);
    current = next;
  }
  current.push(first);
  return first;
};

// Wraps cycleFromTop(n) in p plain arrays: the cycle's first container sits
// at depth p + 1 and its ancestor is re-entered at depth p + n + 1.
const cycleBelow = (p: number, n: number): unknown => {
  let root = cycleFromTop(n);
  for (let i = 0; i < p; i++) root = [root];
  return root;
};

const pattern = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => i % 251);

// ---------------------------------------------------------------------------
// SPEC.md section 4 - the five vectors
// ---------------------------------------------------------------------------

describe("V1 - flat object, GPS profile, single-leaf root", () => {
  const input = { lon: "144.9631000", bounty_id: "42", lat: "-37.8136000" };
  const canonical = '{"bounty_id":"42","lat":"-37.8136000","lon":"144.9631000"}';

  test("canonical string", () => {
    assert.equal(canonicalise(input), canonical);
  });

  test("sha256 of canonical UTF-8", () => {
    assert.equal(
      hex(sha256(utf8(canonical))),
      "faa0b8a8c50d7cf835bfc0853cf940637c6408eaade5b90dc9df2c77d0d0cff3",
    );
  });

  test("single-element merkle root is the leaf node (section 3.3)", () => {
    assert.equal(
      hex(merkleRoot([sha256(utf8(canonical))])),
      "2fed2c3c962d549f593a1e4c44670e4e3bbad3bf15326fc0f77d35d4f0b345f1",
    );
  });
});

describe("V2 - escaping, non-ASCII keys/values, key ordering, empty object", () => {
  const input = {
    z: null,
    [EACUTE + "moji"]: KANGAROO,
    note: "line1" + NL + "line2",
    a: [true, false, {}],
    _: "",
  };
  const canonical =
    '{"_":"","a":[true,false,{}],"note":"line1' +
    BS +
    "n" +
    'line2","z":null,"' +
    EACUTE +
    'moji":"' +
    KANGAROO +
    '"}';

  test("canonical string", () => {
    assert.equal(canonicalise(input), canonical);
  });

  test("canonical form is 75 bytes as UTF-8", () => {
    assert.equal(utf8(canonical).length, 75);
  });

  test("sha256 of canonical UTF-8", () => {
    assert.equal(
      hex(sha256(utf8(canonical))),
      "a288f23950d5fb16f9d9e4e31a027f7d58e62c49560ca2ee29d91bc9fcf1e36e",
    );
  });
});

describe("V3 - integer edges: zero, negative zero, safe bounds, empty array", () => {
  const input = {
    min: -9007199254740991,
    count: 0,
    neg_zero: -0,
    max: 9007199254740991,
    empty_list: [],
  };
  const canonical =
    '{"count":0,"empty_list":[],"max":9007199254740991,' +
    '"min":-9007199254740991,"neg_zero":0}';

  test("canonical string (negative zero serialises as 0)", () => {
    assert.equal(canonicalise(input), canonical);
  });

  test("sha256 of canonical UTF-8", () => {
    assert.equal(
      hex(sha256(utf8(canonical))),
      "5896e68f0096d51f339cece666f84537536459c08226d49068a324cbd3a70edf",
    );
  });
});

describe("V4 and V5 - merkle construction over shared leaves", () => {
  const a = sha256(utf8("leaf-a"));
  const b = sha256(utf8("leaf-b"));
  const c = sha256(utf8("leaf-c"));

  test("leaf digests match the spec table", () => {
    assert.equal(
      hex(a),
      "e9845d1809b292abbfa6e93b1fd1e7be6da0065d23af392017eecc0ab4d0ad0f",
    );
    assert.equal(
      hex(b),
      "b2ff96642b087187598e416db9912019fb27ef02be1d0436fdc1ad7a3b28ae19",
    );
    assert.equal(
      hex(c),
      "3f0c143edf62084b433fe2b16c48bd706a6260245b9f78f3c4a77f730dafc0d3",
    );
  });

  test("leaf nodes L(h) match the spec table (via single-element roots)", () => {
    assert.equal(
      hex(merkleRoot([a])),
      "d40a0e6f288c6f29ee4d01c5ede177f0e4452caf203e259b50865be002c73c3b",
    );
    assert.equal(
      hex(merkleRoot([b])),
      "76827801cb4c471c195edd8fb66bb78a99c9332ec7250695e0be94836cd96164",
    );
    assert.equal(
      hex(merkleRoot([c])),
      "af0cc79e6310820ae6cb42bfec39e40fca73274c7af63a1dd8c5dd61a99dcb0c",
    );
  });

  test("V4 - two leaves, concatenation order", () => {
    assert.equal(
      hex(merkleRoot([a, b])),
      "9c9b47b435b4c8719bf98c8aa9c3840f5a4f986fcd28cb1b676cf1b8b078149f",
    );
  });

  test("V5 - three leaves, odd node promoted not duplicated", () => {
    assert.equal(
      hex(merkleRoot([a, b, c])),
      "95300cb3b0a94c0ac4373e23439a2990066f10ab53374cd73dadc4953a80e88c",
    );
  });

  test("input order is significant and never sorted (section 3.2 step 2)", () => {
    assert.notEqual(hex(merkleRoot([a, b])), hex(merkleRoot([b, a])));
  });

  test("promotion is not duplication: [a,b,c] differs from [a,b,c,c]", () => {
    assert.notEqual(hex(merkleRoot([a, b, c])), hex(merkleRoot([a, b, c, c])));
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 1.2 - key ordering
// ---------------------------------------------------------------------------

describe("key ordering (section 1.2)", () => {
  test("a prefix sorts before the longer key", () => {
    assert.equal(canonicalise({ ab: 1, a: 2 }), '{"a":2,"ab":1}');
  });

  test("key beyond U+FFFF pins UTF-16 code unit order, not UTF-8 byte order", () => {
    // U+FF61 is the single code unit 0xFF61; U+1F998 is the surrogate pair
    // 0xD83E 0xDD98. UTF-16 order: 0xD83E < 0xFF61, so the astral key sorts
    // first. UTF-8 byte order would reverse this (0xF0... > 0xEF...).
    const highBmp = String.fromCharCode(0xff61);
    assert.equal(
      canonicalise({ [highBmp]: 1, [KANGAROO]: 2 }),
      '{"' + KANGAROO + '":2,"' + highBmp + '":1}',
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 1.4 - strings and escaping
// ---------------------------------------------------------------------------

describe("string escaping (section 1.4)", () => {
  test("the five two-character escapes", () => {
    const s = String.fromCharCode(0x08, 0x09, 0x0a, 0x0c, 0x0d);
    assert.equal(
      canonicalise(s),
      '"' + BS + "b" + BS + "t" + BS + "n" + BS + "f" + BS + "r" + '"',
    );
  });

  test("other C0 controls use lowercase six-character escapes", () => {
    assert.equal(canonicalise(String.fromCharCode(0x00)), '"' + BS + 'u0000"');
    assert.equal(canonicalise(String.fromCharCode(0x01)), '"' + BS + 'u0001"');
    assert.equal(canonicalise(String.fromCharCode(0x0b)), '"' + BS + 'u000b"');
    assert.equal(canonicalise(String.fromCharCode(0x1f)), '"' + BS + 'u001f"');
  });

  test("quote and backslash use their single escape forms", () => {
    assert.equal(canonicalise('"'), '"' + BS + '""');
    assert.equal(canonicalise(BS), '"' + BS + BS + '"');
  });

  test("solidus and non-ASCII characters are emitted raw", () => {
    assert.equal(canonicalise("a/b"), '"a/b"');
    assert.equal(canonicalise(EACUTE), '"' + EACUTE + '"');
    assert.equal(canonicalise(KANGAROO), '"' + KANGAROO + '"');
  });

  test("U+007F, U+2028 and U+2029 are emitted raw (rule 2 catch-all)", () => {
    const del = String.fromCharCode(0x7f);
    const lsep = String.fromCharCode(0x2028);
    const psep = String.fromCharCode(0x2029);
    assert.equal(canonicalise(del), '"' + del + '"');
    assert.equal(canonicalise(lsep), '"' + lsep + '"');
    assert.equal(canonicalise(psep), '"' + psep + '"');
  });
});

// ---------------------------------------------------------------------------
// Accepted inputs the spec singles out
// ---------------------------------------------------------------------------

describe("accepted inputs", () => {
  test("null-prototype object with string keys is plain (section 1.1)", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.b = 2;
    o.a = 1;
    assert.equal(canonicalise(o), '{"a":1,"b":2}');
  });

  test("shared non-cyclic references are not cycles (section 1.7 note 3)", () => {
    const shared = { x: 1 };
    assert.equal(
      canonicalise({ a: shared, b: shared }),
      '{"a":{"x":1},"b":{"x":1}}',
    );
  });

  test("U+FEFF end-to-end: canonicalise, UTF-8, sha256 (section 2)", () => {
    const canonical = canonicalise(FEFF + "abc");
    assert.equal(canonical, '"' + FEFF + 'abc"');
    const bytes = utf8(canonical);
    assert.deepEqual(
      Array.from(bytes),
      [0x22, 0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63, 0x22],
    );
    assert.equal(
      hex(sha256(bytes)),
      "82243710211535ea54bd943a2a9243e7b32555b14089268e512cb1c64b1e637c",
    );
  });

  test("nesting depth exactly 64 is accepted (section 1.7 note 2)", () => {
    assert.equal(canonicalise(nested(64)), "[".repeat(64) + "0" + "]".repeat(64));
  });

  test("depth counting sanity: {a:[1]} has depth 2 (section 1.7 note 2)", () => {
    assert.equal(canonicalise({ a: [1] }), '{"a":[1]}');
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 6.1 - one single-fault test per code
// ---------------------------------------------------------------------------

describe("canonicalise rejection codes (section 6.1)", () => {
  test("NON_FINITE_NUMBER", () => {
    rejectsWith(() => canonicalise(NaN), "NON_FINITE_NUMBER");
    rejectsWith(() => canonicalise(Infinity), "NON_FINITE_NUMBER");
    rejectsWith(() => canonicalise(-Infinity), "NON_FINITE_NUMBER");
  });

  test("NON_INTEGER_NUMBER", () => {
    rejectsWith(() => canonicalise(1.5), "NON_INTEGER_NUMBER");
    rejectsWith(() => canonicalise(-0.1), "NON_INTEGER_NUMBER");
  });

  test("UNSAFE_INTEGER", () => {
    rejectsWith(() => canonicalise(2 ** 53), "UNSAFE_INTEGER");
    rejectsWith(() => canonicalise(-(2 ** 53)), "UNSAFE_INTEGER");
  });

  test("BIGINT", () => {
    rejectsWith(() => canonicalise(BigInt(1)), "BIGINT");
  });

  test("UNDEFINED", () => {
    rejectsWith(() => canonicalise(undefined), "UNDEFINED");
    rejectsWith(() => canonicalise({ a: undefined }), "UNDEFINED");
    rejectsWith(() => canonicalise([undefined]), "UNDEFINED");
  });

  test("FUNCTION_OR_SYMBOL", () => {
    rejectsWith(() => canonicalise(() => 0), "FUNCTION_OR_SYMBOL");
    rejectsWith(() => canonicalise(Symbol("x")), "FUNCTION_OR_SYMBOL");
    rejectsWith(() => canonicalise({ toJSON: () => "x" }), "FUNCTION_OR_SYMBOL");
  });

  test("NON_PLAIN_OBJECT", () => {
    rejectsWith(() => canonicalise(new Date(0)), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(new Map()), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(new Set()), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(/x/), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(new Uint8Array(1)), "NON_PLAIN_OBJECT");
    class Evidence {
      a = 1;
    }
    rejectsWith(() => canonicalise(new Evidence()), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(new String("x")), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(new Number(1)), "NON_PLAIN_OBJECT");
    rejectsWith(() => canonicalise(new Boolean(true)), "NON_PLAIN_OBJECT");
    class SubArray extends Array<number> {}
    const sub = new SubArray();
    sub.push(1);
    rejectsWith(() => canonicalise(sub), "NON_PLAIN_OBJECT");
    const nullProtoArray = [1, 2];
    Object.setPrototypeOf(nullProtoArray, null);
    rejectsWith(() => canonicalise(nullProtoArray), "NON_PLAIN_OBJECT");
  });

  test("SYMBOL_KEY", () => {
    const o: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o, Symbol("s"), { value: 2, enumerable: true });
    rejectsWith(() => canonicalise(o), "SYMBOL_KEY");
  });

  test("ACCESSOR_PROPERTY", () => {
    const o = {
      get a() {
        return 1;
      },
    };
    rejectsWith(() => canonicalise(o), "ACCESSOR_PROPERTY");
    const arr = [0];
    Object.defineProperty(arr, 0, {
      get: () => 1,
      enumerable: true,
      configurable: true,
    });
    rejectsWith(() => canonicalise(arr), "ACCESSOR_PROPERTY");
  });

  test("ACCESSOR_PROPERTY: object property with get and set both undefined", () => {
    const o2: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o2, "b", { get: undefined, enumerable: true, configurable: true });
    rejectsWith(() => canonicalise(o2), "ACCESSOR_PROPERTY");
  });

  test("ACCESSOR_PROPERTY: array index with get and set both undefined", () => {
    const arr2 = [0];
    Object.defineProperty(arr2, 0, { get: undefined, enumerable: true, configurable: true });
    rejectsWith(() => canonicalise(arr2), "ACCESSOR_PROPERTY");
  });

  test("NON_ENUMERABLE_PROPERTY", () => {
    const o = { a: 1 };
    Object.defineProperty(o, "hidden", { value: 2, enumerable: false });
    rejectsWith(() => canonicalise(o), "NON_ENUMERABLE_PROPERTY");
    const arr = [7];
    Object.defineProperty(arr, 0, { enumerable: false });
    rejectsWith(() => canonicalise(arr), "NON_ENUMERABLE_PROPERTY");
  });

  test("ARRAY_HOLE", () => {
    const sparse = [1, 3];
    sparse.length = 3;
    rejectsWith(() => canonicalise(sparse), "ARRAY_HOLE");
  });

  test("ARRAY_EXTRA_PROPERTY", () => {
    const arr: unknown[] = [1];
    Object.defineProperty(arr, "note", { value: "x", enumerable: true });
    rejectsWith(() => canonicalise(arr), "ARRAY_EXTRA_PROPERTY");
  });

  test("LONE_SURROGATE", () => {
    rejectsWith(() => canonicalise(String.fromCharCode(0xd800)), "LONE_SURROGATE");
    rejectsWith(() => canonicalise(String.fromCharCode(0xdfff)), "LONE_SURROGATE");
    const inValue = "a" + String.fromCharCode(0xd800) + "b";
    rejectsWith(() => canonicalise(inValue), "LONE_SURROGATE");
    const key = String.fromCharCode(0xdc00);
    rejectsWith(() => canonicalise({ [key]: 1 }), "LONE_SURROGATE");
  });

  test("DEPTH_LIMIT", () => {
    rejectsWith(() => canonicalise(nested(65)), "DEPTH_LIMIT");
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 6.3 - cycle/depth boundary (arrays only, no other fault)
// ---------------------------------------------------------------------------

describe("cycle versus depth check order (section 6.3)", () => {
  test("self-containing array (n = 1, re-entry depth 2): CYCLIC", () => {
    rejectsWith(() => canonicalise(cycleFromTop(1)), "CYCLIC");
  });

  test("64-container cycle from the top (re-entry depth 65): CYCLIC", () => {
    rejectsWith(() => canonicalise(cycleFromTop(64)), "CYCLIC");
  });

  test("65-container cycle from the top (depth 65 is a first visit): DEPTH_LIMIT", () => {
    rejectsWith(() => canonicalise(cycleFromTop(65)), "DEPTH_LIMIT");
  });

  test("P = 10 ancestors, n = 54 (P + n = 64, re-entry depth 65): CYCLIC", () => {
    rejectsWith(() => canonicalise(cycleBelow(10, 54)), "CYCLIC");
  });

  test("P = 10 ancestors, n = 55 (P + n = 65): DEPTH_LIMIT", () => {
    rejectsWith(() => canonicalise(cycleBelow(10, 55)), "DEPTH_LIMIT");
  });
});

// ---------------------------------------------------------------------------
// Multi-code inputs - section 6.3: the thrown code is unspecified, so these
// assert instanceof SpecError only and must not pin a code.
// ---------------------------------------------------------------------------

describe("multi-code inputs (section 6.3, code unspecified)", () => {
  test("symbol-keyed property on an array", () => {
    const arr: unknown[] = [1];
    Object.defineProperty(arr, Symbol("s"), { value: 1, enumerable: true });
    assert.throws(() => canonicalise(arr), SpecError);
  });

  test("non-enumerable named property on an array", () => {
    const arr: unknown[] = [1];
    Object.defineProperty(arr, "note", { value: "x", enumerable: false });
    assert.throws(() => canonicalise(arr), SpecError);
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 2 - sha256
// ---------------------------------------------------------------------------

describe("sha256 (section 2)", () => {
  test("NOT_BYTES for every non-Uint8Array input", () => {
    const bad: unknown[] = [
      "616263",
      [1, 2, 3],
      undefined,
      new ArrayBuffer(8),
      new DataView(new ArrayBuffer(8)),
      new Uint8ClampedArray(8),
      new Uint16Array(8),
    ];
    for (const value of bad) {
      rejectsWith(() => sha256(value as Uint8Array), "NOT_BYTES");
    }
  });

  test("Buffer (a Uint8Array subclass) is accepted", () => {
    assert.equal(
      hex(sha256(Buffer.from("abc"))),
      createHash("sha256").update("abc").digest("hex"),
    );
  });

  test("bytes in view: subarray with non-zero byteOffset", () => {
    const big = pattern(100);
    const view = big.subarray(10, 42);
    assert.equal(view.byteOffset, 10); // precondition: a real offset view
    assert.equal(view.length, 32);
    assert.equal(
      hex(sha256(view)),
      createHash("sha256").update(big.slice(10, 42)).digest("hex"),
    );
  });

  test("bytes in view: pooled Buffer with non-zero byteOffset", () => {
    Buffer.from("advance-the-pool"); // ensure the pool offset is past zero
    const buf = Buffer.from("abc");
    assert.notEqual(buf.byteOffset, 0); // precondition: test is not vacuous
    assert.equal(
      hex(sha256(buf)),
      createHash("sha256").update("abc").digest("hex"),
    );
  });

  describe("differential against node:crypto (test-only oracle)", () => {
    const sizes = [0, 55, 56, 64, 65, 1000];
    for (const n of sizes) {
      test(n + " bytes", () => {
        const bytes = pattern(n);
        assert.equal(
          hex(sha256(bytes)),
          createHash("sha256").update(bytes).digest("hex"),
        );
      });
    }

    test("non-ASCII UTF-8", () => {
      const bytes = utf8(EACUTE + KANGAROO + FEFF + "plain");
      assert.equal(
        hex(sha256(bytes)),
        createHash("sha256").update(bytes).digest("hex"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// SPEC.md sections 3.2 step 1 and 3.3 - merkleRoot inputs
// ---------------------------------------------------------------------------

describe("merkleRoot input handling (sections 3.2 step 1, 3.3)", () => {
  const good = sha256(utf8("leaf-a"));

  test("NOT_AN_ARRAY", () => {
    rejectsWith(() => merkleRoot(new Uint8Array(32) as unknown as Uint8Array[]), "NOT_AN_ARRAY");
    rejectsWith(() => merkleRoot("abc" as unknown as Uint8Array[]), "NOT_AN_ARRAY");
    rejectsWith(() => merkleRoot(undefined as unknown as Uint8Array[]), "NOT_AN_ARRAY");
  });

  test("EMPTY_LIST", () => {
    rejectsWith(() => merkleRoot([]), "EMPTY_LIST");
  });

  test("ELEMENT_NOT_BYTES", () => {
    const bad: unknown[] = [
      new Array<number>(32).fill(0),
      "x".repeat(32),
      hex(good), // 64-char hex string
      new ArrayBuffer(32),
    ];
    for (const value of bad) {
      rejectsWith(() => merkleRoot([value as Uint8Array]), "ELEMENT_NOT_BYTES");
    }
  });

  test("ELEMENT_NOT_32_BYTES", () => {
    rejectsWith(() => merkleRoot([new Uint8Array(31)]), "ELEMENT_NOT_32_BYTES");
    rejectsWith(() => merkleRoot([new Uint8Array(33)]), "ELEMENT_NOT_32_BYTES");
    rejectsWith(() => merkleRoot([new Uint8Array(0)]), "ELEMENT_NOT_32_BYTES");
    rejectsWith(() => merkleRoot([new Uint8Array(64)]), "ELEMENT_NOT_32_BYTES");
    rejectsWith(
      () => merkleRoot([good, new Uint8Array(31)]),
      "ELEMENT_NOT_32_BYTES",
    );
  });

  test("a 32-byte subarray view equals a copied 32-byte array", () => {
    const big = pattern(96);
    const view = big.subarray(32, 64);
    assert.equal(view.byteOffset, 32); // precondition: a real offset view
    const copy = big.slice(32, 64);
    assert.equal(hex(merkleRoot([view])), hex(merkleRoot([copy])));
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 5 item 3 - no configuration options
// ---------------------------------------------------------------------------

describe("no configuration options (section 5)", () => {
  test("a second argument is a compile-time error and never changes output", () => {
    const one = canonicalise({ a: 1 });
    // @ts-expect-error canonicalise accepts exactly one argument
    const two = canonicalise({ a: 1 }, "option");
    assert.equal(two, one);

    const bytes = utf8("abc");
    const d1 = hex(sha256(bytes));
    // @ts-expect-error sha256 accepts exactly one argument
    const d2 = hex(sha256(bytes, "hex"));
    assert.equal(d2, d1);

    const leaf = sha256(bytes);
    const r1 = hex(merkleRoot([leaf]));
    // @ts-expect-error merkleRoot accepts exactly one argument
    const r2 = hex(merkleRoot([leaf], true));
    assert.equal(r2, r1);
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 7 - eligibility profiles
// ---------------------------------------------------------------------------

describe("eligibility profiles (section 7)", () => {
  const TAG = "BOUNTYCAM_ELIGIBILITY_PROFILE_V1";

  const BASE_V1: EligibilityProfile = {
    domain_tag: TAG,
    profile_id: "BASE_V1",
    requires_sgt: false,
  };

  const A4_SEEKER_V1: EligibilityProfile = {
    domain_tag: TAG,
    profile_id: "A4_SEEKER_V1",
    requires_sgt: true,
  };

  test("P1 BASE_V1 reproduces its section 7.4 text, length and hash", () => {
    const text = canonicalise(BASE_V1);
    assert.equal(
      text,
      '{"domain_tag":"BOUNTYCAM_ELIGIBILITY_PROFILE_V1",' +
        '"profile_id":"BASE_V1","requires_sgt":false}',
    );
    assert.equal(utf8(text).length, 93);
    assert.equal(
      hex(eligibilityProfileHash(BASE_V1)),
      "0d2a8920d85f17637cff555ef00869418767b4de9cb72cc553c8944ccfd0deb9",
    );
  });

  test("P2 A4_SEEKER_V1 reproduces its section 7.4 text, length and hash", () => {
    const text = canonicalise(A4_SEEKER_V1);
    assert.equal(
      text,
      '{"domain_tag":"BOUNTYCAM_ELIGIBILITY_PROFILE_V1",' +
        '"profile_id":"A4_SEEKER_V1","requires_sgt":true}',
    );
    assert.equal(utf8(text).length, 97);
    assert.equal(
      hex(eligibilityProfileHash(A4_SEEKER_V1)),
      "a1bcc81f8046565564915d5e7eead4cc1108003100c29f453de9325bd2198cbe",
    );
  });

  test("key order in the input never changes the hash", () => {
    const reordered = {
      requires_sgt: false,
      profile_id: "BASE_V1",
      domain_tag: TAG,
    };
    assert.equal(
      hex(eligibilityProfileHash(reordered)),
      hex(eligibilityProfileHash(BASE_V1)),
    );
  });

  test("redefining requires_sgt under the same id changes the hash (7.5)", () => {
    const redefined: EligibilityProfile = { ...BASE_V1, requires_sgt: true };
    assert.notEqual(
      hex(eligibilityProfileHash(redefined)),
      hex(eligibilityProfileHash(BASE_V1)),
    );
  });

  test("PROFILE_SHAPE_INVALID", () => {
    const withGetter = Object.defineProperty(
      { profile_id: "BASE_V1", requires_sgt: false },
      "domain_tag",
      { get: () => TAG, enumerable: true, configurable: true },
    );
    const bad: unknown[] = [
      null,
      "BASE_V1",
      [BASE_V1],
      Object.assign(Object.create({}), BASE_V1),
      { domain_tag: TAG, profile_id: "BASE_V1" },
      { ...BASE_V1, extra: 1 },
      { ...BASE_V1, domain_tag: "BOUNTYCAM_ELIGIBILITY_PROFILE_V2" },
      { ...BASE_V1, requires_sgt: "false" },
      { ...BASE_V1, profile_id: 7 },
      withGetter,
    ];
    for (const value of bad) {
      rejectsWith(
        () => eligibilityProfileHash(value as EligibilityProfile),
        "PROFILE_SHAPE_INVALID",
      );
    }
  });

  test("PROFILE_ID_INVALID, and a 40-character id is accepted", () => {
    const bad = [
      "base_v1",
      "BASE",
      "BASE_V",
      "_BASE_V1",
      "1_BASE_V1",
      "",
      "BASE V1",
      "B".repeat(38) + "_V1",
    ];
    for (const id of bad) {
      rejectsWith(
        () => eligibilityProfileHash({ ...BASE_V1, profile_id: id }),
        "PROFILE_ID_INVALID",
      );
    }
    const longest = "B".repeat(37) + "_V1";
    assert.equal(longest.length, 40);
    assert.equal(hex(eligibilityProfileHash({ ...BASE_V1, profile_id: longest })).length, 64);
  });
});

// MESSAGES.md section 4 - BOUNTYCAM_ELIGIBILITY_V1, against the published vectors.
// vectors.json is read relative to the package root, which is the cwd when the
// suite runs through pnpm --filter.
describe("eligibility message (MESSAGES.md section 4)", () => {
  const vectors = JSON.parse(
    readFileSync(join(process.cwd(), "vectors", "vectors.json"), "utf8"),
  ) as {
    authorities: { eligibility_seed_ascii: string; eligibility_pubkey_hex: string };
    layouts: Record<
      string,
      { total_bytes: number; fields: { offset: number; width: number; field: string }[] }
    >;
    vectors: { name: string; message_len: number; message_hex: string; signature_hex: string }[];
  };
  const voucherVectors = vectors.vectors.filter((v) => v.message_len === 212);
  const hex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
  const SPKI_PREFIX = "302a300506032b6570032100";
  const PKCS8_PREFIX = "302e020100300506032b657004220420";

  function fieldsOf(m: Uint8Array): EligibilityMessageFields {
    const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
    return {
      deploymentId: dv.getUint8(26),
      programId: m.slice(27, 59),
      bountyId: m.slice(59, 75),
      requester: m.slice(75, 107),
      scout: m.slice(107, 139),
      policyHash: m.slice(139, 171),
      eligibilityProfileHash: m.slice(171, 203),
      requiredAssurance: dv.getUint8(203),
      expiresAt: dv.getBigInt64(204, true),
    };
  }

  const nominal = (): EligibilityMessageFields => fieldsOf(hex(voucherVectors[0]!.message_hex));

  test("constants: 24-byte ASCII tag, length 212, schema version 1, ceiling 4", () => {
    assert.equal(new TextEncoder().encode(ELIGIBILITY_DOMAIN_TAG).length, 24);
    assert.equal(ELIGIBILITY_MESSAGE_LENGTH, 212);
    assert.equal(ELIGIBILITY_SCHEMA_VERSION, 1);
    assert.equal(MAX_ASSURANCE_LEVEL, 4);
    assert.equal(voucherVectors.length, 4);
  });

  test("every 212-byte vector reproduces byte for byte from its parsed fields", () => {
    for (const v of voucherVectors) {
      const m = hex(v.message_hex);
      const rebuilt = eligibilityMessage(fieldsOf(m));
      assert.equal(Buffer.from(rebuilt).toString("hex"), v.message_hex, v.name);
    }
  });

  test("every vector signature verifies under the published eligibility key", () => {
    const pub = createPublicKey({
      key: Buffer.from(SPKI_PREFIX + vectors.authorities.eligibility_pubkey_hex, "hex"),
      format: "der",
      type: "spki",
    });
    for (const v of voucherVectors) {
      assert.ok(verify(null, hex(v.message_hex), pub, hex(v.signature_hex)), v.name);
    }
    const seed = Buffer.from(vectors.authorities.eligibility_seed_ascii, "ascii");
    assert.equal(seed.length, 32);
    const priv = createPrivateKey({
      key: Buffer.concat([Buffer.from(PKCS8_PREFIX, "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    const derived = createPublicKey(priv).export({ format: "der", type: "spki" });
    assert.equal(
      Buffer.from(derived).subarray(-32).toString("hex"),
      vectors.authorities.eligibility_pubkey_hex,
    );
  });

  test("published layout agrees with the offsets the builder writes", () => {
    const layout = vectors.layouts["BOUNTYCAM_ELIGIBILITY_V1"]!;
    assert.equal(layout.total_bytes, 212);
    const expected: [string, number, number][] = [
      ["domain_tag", 0, 24], ["schema_version", 24, 2], ["deployment_id", 26, 1],
      ["program_id", 27, 32], ["bounty_id", 59, 16], ["requester", 75, 32],
      ["scout", 107, 32], ["policy_hash", 139, 32], ["eligibility_profile_hash", 171, 32],
      ["required_assurance", 203, 1], ["expires_at", 204, 8],
    ];
    assert.deepEqual(
      layout.fields.map((f) => [f.field, f.offset, f.width]),
      expected,
    );
  });

  test("byte fields: wrong width is MESSAGE_FIELD_LENGTH, non-bytes is NOT_BYTES", () => {
    const widths: [keyof EligibilityMessageFields, number][] = [
      ["programId", 32], ["bountyId", 16], ["requester", 32],
      ["scout", 32], ["policyHash", 32], ["eligibilityProfileHash", 32],
    ];
    for (const [name, width] of widths) {
      for (const bad of [width - 1, width + 1, 0]) {
        assert.throws(
          () => eligibilityMessage({ ...nominal(), [name]: new Uint8Array(bad) }),
          (e: unknown) => e instanceof SpecError && e.code === "MESSAGE_FIELD_LENGTH",
          name + " at " + bad,
        );
      }
      assert.throws(
        () => eligibilityMessage({ ...nominal(), [name]: Array.from(new Uint8Array(width)) }),
        (e: unknown) => e instanceof SpecError && e.code === "MESSAGE_FIELD_NOT_BYTES",
        name,
      );
    }
  });

  test("u8 fields: out-of-range or non-integer is MESSAGE_FIELD_RANGE", () => {
    const isRange = (e: unknown) => e instanceof SpecError && e.code === "MESSAGE_FIELD_RANGE";
    for (const bad of [-1, 256, 1.5, NaN, "1"]) {
      assert.throws(
        () => eligibilityMessage({ ...nominal(), deploymentId: bad as number }),
        isRange,
      );
    }
    for (const bad of [-1, 5, 2.5]) {
      assert.throws(
        () => eligibilityMessage({ ...nominal(), requiredAssurance: bad }),
        isRange,
      );
    }
    for (const ok of [0, 255]) {
      const m = eligibilityMessage({ ...nominal(), deploymentId: ok });
      assert.equal(new DataView(m.buffer).getUint8(26), ok);
    }
    for (const ok of [0, 4]) {
      const m = eligibilityMessage({ ...nominal(), requiredAssurance: ok });
      assert.equal(new DataView(m.buffer).getUint8(203), ok);
    }
  });

  test("expiresAt: i64 bounds round-trip; beyond them or a number is MESSAGE_FIELD_RANGE", () => {
    const isRange = (e: unknown) => e instanceof SpecError && e.code === "MESSAGE_FIELD_RANGE";
    const min = -(1n << 63n);
    const max = (1n << 63n) - 1n;
    for (const ok of [min, max, 0n]) {
      const m = eligibilityMessage({ ...nominal(), expiresAt: ok });
      assert.equal(new DataView(m.buffer).getBigInt64(204, true), ok);
    }
    for (const bad of [min - 1n, max + 1n]) {
      assert.throws(() => eligibilityMessage({ ...nominal(), expiresAt: bad }), isRange);
    }
    assert.throws(
      () => eligibilityMessage({ ...nominal(), expiresAt: 1 as unknown as bigint }),
      isRange,
    );
  });

  test("check order: the earliest-offset failure wins", () => {
    assert.throws(
      () =>
        eligibilityMessage({
          ...nominal(),
          programId: new Uint8Array(31),
          expiresAt: 1 as unknown as bigint,
        }),
      (e: unknown) => e instanceof SpecError && e.code === "MESSAGE_FIELD_LENGTH",
    );
    assert.throws(
      () =>
        eligibilityMessage({
          ...nominal(),
          deploymentId: 256,
          programId: new Uint8Array(31),
        }),
      (e: unknown) => e instanceof SpecError && e.code === "MESSAGE_FIELD_RANGE",
    );
  });
});

// ---------------------------------------------------------------------------
// SPEC.md section 8 — funding-path helpers (Session 17, tests 81 to 110)
// ---------------------------------------------------------------------------

const V1_POLICY_TEXT =
  '{"acceptance_window_seconds":86400,"capture_radius_m":50,"chain":"solana",' +
  '"challenge_window_seconds":3600,"cluster":"devnet","completion_window_seconds":7200,' +
  '"domain_tag":"BOUNTYCAM_POLICY_V1","eligibility_profile_id":"BASE_V1",' +
  '"evidence_requirements":[{"id":"11111111-1111-4111-8111-111111111111",' +
  '"prompt":"Storefront with signage visible","required":true,"type":"PHOTO"}],' +
  '"fee_amount":"0","lat":"40.4405556","lon":"-79.9961111","required_assurance":3,' +
  '"reward_amount":"5000000",' +
  '"salt":"000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",' +
  '"settlement_mint":"11111111111111111111111111111111"}';
const V1_HASH = "711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b";
const P1_HASH = "0d2a8920d85f17637cff555ef00869418767b4de9cb72cc553c8944ccfd0deb9";
const P2_HASH = "a1bcc81f8046565564915d5e7eead4cc1108003100c29f453de9325bd2198cbe";
const U1 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const U1_HEX = "0f8fad5bd9cb469fa16570867728950e";
const C1_HEX =
  "51f153b313cba7400f8fad5bd9cb469fa16570867728950e404b4c0000000000" +
  "711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b" +
  "0d2a8920d85f17637cff555ef00869418767b4de9cb72cc553c8944ccfd0deb9" +
  "038051010000000000201c000000000000100e000000000000";
const C1_SHA = "43f757e67d6c06b5808bd316a752f182ec7f2b0623af72c303d25b7a54b0b714";
const ARABIC_ONE = String.fromCodePoint(0x0661); // U+0661 ARABIC-INDIC DIGIT ONE
const SPACE = String.fromCharCode(0x20);

const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

const c1Args = (): FundingArgs => ({
  bountyId: uuidBytes(U1),
  rewardAmount: 5000000n,
  policyHash: fromHex(V1_HASH),
  eligibilityProfileHash: fromHex(P1_HASH),
  requiredAssurance: 3,
  acceptanceWindowSecs: 86400n,
  completionWindowSecs: 7200n,
  reviewWindowSecs: 3600n,
});

const v1Policy = (): Record<string, unknown> =>
  JSON.parse(V1_POLICY_TEXT) as Record<string, unknown>;
const v1Expected = (): CreatedBountyExpectation => ({
  cluster: "devnet",
  settlementMint: "11111111111111111111111111111111",
  title: "Storefront check",
  category: "Retail",
  policy: {
    acceptance_window_seconds: 86400,
    capture_radius_m: 50,
    challenge_window_seconds: 3600,
    completion_window_seconds: 7200,
    eligibility_profile_id: "BASE_V1",
    evidence_requirements: [
      { prompt: "Storefront with signage visible", required: true, type: "PHOTO" },
    ],
    lat: "40.4405556",
    lon: "-79.9961111",
    required_assurance: 3,
    reward_amount: "5000000",
  },
});
const v1Response = (policy: Record<string, unknown> = v1Policy(), policyHash?: string) => ({
  id: U1,
  title: "Storefront check",
  category: "Retail",
  state: "DRAFT",
  program_account: null,
  created_at: "2026-09-28T00:00:00.000Z",
  policy_hash: policyHash ?? hex(sha256(utf8(canonicalise(policy)))),
  policy,
});

describe("GPS profile (SPEC.md 8.1)", () => {
  test("81 isValidLat and isValidLon accept the profile forms", () => {
    for (const v of ["0.0000000", "90.0000000", "-90.0000000", "-33.8688197"]) {
      assert.equal(isValidLat(v), true, v);
    }
    for (const v of ["180.0000000", "-180.0000000", "151.2092955"]) {
      assert.equal(isValidLon(v), true, v);
    }
  });

  test("82 both reject every form failure", () => {
    const bad: unknown[] = [
      "1.000000",
      "1.00000000",
      "01.0000000",
      "+1.0000000",
      "-0.0000000",
      "1e1",
      SPACE + "1.0000000",
      ARABIC_ONE + ".0000000",
      "",
      1,
    ];
    for (const v of bad) {
      assert.equal(isValidLat(v as string), false, String(v));
      assert.equal(isValidLon(v as string), false, String(v));
    }
  });

  test("83 both reject range failures", () => {
    assert.equal(isValidLat("90.0000001"), false);
    assert.equal(isValidLat("-90.0000001"), false);
    assert.equal(isValidLon("180.0000001"), false);
    assert.equal(isValidLon("-180.0000001"), false);
  });

  test("84 gpsToScaled: exact scaling; a form failure is GPS_FORM_INVALID", () => {
    assert.equal(gpsToScaled("-33.8688197"), -338688197n);
    assert.equal(gpsToScaled("0.0000000"), 0n);
    assert.equal(gpsToScaled("180.0000000"), 1800000000n);
    rejectsWith(() => gpsToScaled("1.000000"), "GPS_FORM_INVALID");
  });

  test("85 formatCoordinate produces the profile form", () => {
    assert.equal(formatCoordinate(-33.8688197, "lat"), "-33.8688197");
    assert.equal(formatCoordinate(151.2092955, "lon"), "151.2092955");
    assert.equal(formatCoordinate(0, "lat"), "0.0000000");
    assert.equal(formatCoordinate(-0, "lat"), "0.0000000");
    assert.equal(formatCoordinate(-0.00000004, "lat"), "0.0000000");
    assert.equal(formatCoordinate(90, "lat"), "90.0000000");
    assert.equal(formatCoordinate(-179.99999996, "lon"), "-180.0000000");
  });

  test("86 formatCoordinate rejects non-finite and out-of-range values", () => {
    rejectsWith(() => formatCoordinate(NaN, "lat"), "GPS_NOT_FINITE");
    rejectsWith(() => formatCoordinate(Infinity, "lon"), "GPS_NOT_FINITE");
    rejectsWith(() => formatCoordinate(90.00000006, "lat"), "GPS_OUT_OF_RANGE");
    rejectsWith(() => formatCoordinate(180.1, "lon"), "GPS_OUT_OF_RANGE");
    rejectsWith(() => formatCoordinate(1e21, "lat"), "GPS_OUT_OF_RANGE");
  });

  test("87 parseCoordinatePair accepts pasted pairs", () => {
    const want = { lat: "-33.8688197", lon: "151.2092955" };
    assert.deepEqual(parseCoordinatePair("-33.8688197, 151.2092955"), want);
    assert.deepEqual(parseCoordinatePair("-33.8688197,151.2092955"), want);
    assert.deepEqual(
      parseCoordinatePair(
        SPACE + "-33.86881970000001" + SPACE + "," + SPACE + "151.2092955" + SPACE,
      ),
      want,
    );
    assert.deepEqual(parseCoordinatePair("-33, 151"), { lat: "-33.0000000", lon: "151.0000000" });
  });

  test("88 parseCoordinatePair rejects malformed and out-of-range pairs", () => {
    for (const t of ["", "-33.8688197", "1, 2, 3", "a, b", "1e2, 3", "+1, 2", ".5, 2", "1., 2"]) {
      rejectsWith(() => parseCoordinatePair(t), "GPS_PAIR_INVALID");
    }
    rejectsWith(() => parseCoordinatePair("91, 0"), "GPS_OUT_OF_RANGE");
    rejectsWith(() => parseCoordinatePair("0, 181"), "GPS_OUT_OF_RANGE");
  });
});

describe("eligibility profile registry (SPEC.md 8.2)", () => {
  test("89 exactly two ids, hashing to P1 and P2", () => {
    assert.deepEqual([...ELIGIBILITY_PROFILES.keys()], ["BASE_V1", "A4_SEEKER_V1"]);
    assert.equal(hex(eligibilityProfileHash(ELIGIBILITY_PROFILES.get("BASE_V1")!)), P1_HASH);
    assert.equal(hex(eligibilityProfileHash(ELIGIBILITY_PROFILES.get("A4_SEEKER_V1")!)), P2_HASH);
  });

  test("90 admissibleProfileId is the section 2.5 bijection", () => {
    for (const a of [0, 1, 2, 3]) assert.equal(admissibleProfileId(a), "BASE_V1");
    assert.equal(admissibleProfileId(4), "A4_SEEKER_V1");
    for (const a of [5, -1, 1.5, "1"]) {
      rejectsWith(() => admissibleProfileId(a as number), "ASSURANCE_OUT_OF_RANGE");
    }
  });
});

describe("uuidBytes (SPEC.md 8.3)", () => {
  test("91 reproduces U1 as a fresh 16-byte array", () => {
    const a = uuidBytes(U1);
    const b = uuidBytes(U1);
    assert.equal(hex(a), U1_HEX);
    assert.equal(a.length, 16);
    assert.notEqual(a, b);
  });

  test("92 rejects every other form", () => {
    for (const v of [U1.toUpperCase(), U1_HEX, "{" + U1 + "}", U1.slice(0, 35), 7]) {
      rejectsWith(() => uuidBytes(v as string), "UUID_FORM_INVALID");
    }
  });
});

describe("createAndFundData (SPEC.md 8.4)", () => {
  test("93 reproduces C1", () => {
    const out = createAndFundData(c1Args());
    assert.equal(out.length, 121);
    assert.equal(hex(out), C1_HEX);
    assert.equal(hex(sha256(out)), C1_SHA);
  });

  test("94 the discriminator is sha256(global:create_and_fund)[0..8]", () => {
    assert.equal(
      hex(CREATE_AND_FUND_DISCRIMINATOR),
      hex(sha256(utf8("global:create_and_fund")).slice(0, 8)),
    );
  });

  test("95 FUND_FIELD_RANGE for every numeric bound", () => {
    const cases: Partial<Record<keyof FundingArgs, unknown>>[] = [
      { rewardAmount: 0n },
      { rewardAmount: 1n << 64n },
      { rewardAmount: 5000000 },
      { requiredAssurance: 5 },
      { requiredAssurance: -1 },
      { acceptanceWindowSecs: 0n },
      { acceptanceWindowSecs: 2592001n },
      { completionWindowSecs: 0n },
      { completionWindowSecs: 2592001n },
      { reviewWindowSecs: 0n },
      { reviewWindowSecs: 86401n },
    ];
    for (const c of cases) {
      rejectsWith(
        () => createAndFundData({ ...c1Args(), ...c } as FundingArgs),
        "FUND_FIELD_RANGE",
      );
    }
  });

  test("96 FUND_FIELD_LENGTH and FUND_FIELD_NOT_BYTES", () => {
    rejectsWith(
      () => createAndFundData({ ...c1Args(), bountyId: new Uint8Array(15) }),
      "FUND_FIELD_LENGTH",
    );
    rejectsWith(
      () => createAndFundData({ ...c1Args(), policyHash: new Uint8Array(31) }),
      "FUND_FIELD_LENGTH",
    );
    rejectsWith(
      () => createAndFundData({ ...c1Args(), eligibilityProfileHash: new Uint8Array(33) }),
      "FUND_FIELD_LENGTH",
    );
    rejectsWith(
      () =>
        createAndFundData({
          ...c1Args(),
          policyHash: Array(32).fill(0) as unknown as Uint8Array,
        }),
      "FUND_FIELD_NOT_BYTES",
    );
  });
});

describe("verifyCreatedBounty (SPEC.md 8.5)", () => {
  test("97 accepts V1 and yields the C1 arguments", () => {
    const response = v1Response();
    assert.equal(response.policy_hash, V1_HASH);
    const args = verifyCreatedBounty(response, v1Expected());
    assert.equal(hex(createAndFundData(args)), C1_HEX);
  });

  test("98 CREATED_SHAPE_INVALID: a missing field, a wrong state, duplicate ids", () => {
    const noSalt = v1Policy();
    delete noSalt["salt"];
    rejectsWith(
      () => verifyCreatedBounty(v1Response(noSalt), v1Expected()),
      "CREATED_SHAPE_INVALID",
    );
    rejectsWith(
      () => verifyCreatedBounty({ ...v1Response(), state: "AVAILABLE" }, v1Expected()),
      "CREATED_SHAPE_INVALID",
    );
    const twice = v1Policy();
    const item = (twice["evidence_requirements"] as unknown[])[0];
    twice["evidence_requirements"] = [item, { ...(item as object) }];
    rejectsWith(
      () => verifyCreatedBounty(v1Response(twice), v1Expected()),
      "CREATED_SHAPE_INVALID",
    );
  });

  test("99 CREATED_HASH_MISMATCH", () => {
    const tampered = V1_HASH.slice(0, 63) + (V1_HASH.endsWith("b") ? "c" : "b");
    rejectsWith(
      () => verifyCreatedBounty(v1Response(v1Policy(), tampered), v1Expected()),
      "CREATED_HASH_MISMATCH",
    );
  });

  test("100 CREATED_CONSTANT_MISMATCH with a self-consistent hash", () => {
    const p = v1Policy();
    p["fee_amount"] = "1";
    rejectsWith(
      () => verifyCreatedBounty(v1Response(p), v1Expected()),
      "CREATED_CONSTANT_MISMATCH",
    );
  });

  test("101 CREATED_ENVIRONMENT_MISMATCH", () => {
    rejectsWith(
      () => verifyCreatedBounty(v1Response(), { ...v1Expected(), cluster: "mainnet-beta" }),
      "CREATED_ENVIRONMENT_MISMATCH",
    );
  });

  test("102 CREATED_FIELD_MISMATCH: a tampered reward with a self-consistent hash", () => {
    const p = v1Policy();
    p["reward_amount"] = "50000000";
    rejectsWith(() => verifyCreatedBounty(v1Response(p), v1Expected()), "CREATED_FIELD_MISMATCH");
  });
});

describe("decimalToBaseUnits (SPEC.md 8.6)", () => {
  test("103 accepts decimal amounts", () => {
    assert.equal(decimalToBaseUnits("10", 6), "10000000");
    assert.equal(decimalToBaseUnits("10.5", 6), "10500000");
    assert.equal(decimalToBaseUnits("0.000001", 6), "1");
    assert.equal(decimalToBaseUnits("18446744073709.551615", 6), "18446744073709551615");
  });

  test("104 AMOUNT_FORM_INVALID", () => {
    for (const t of ["0.0000001", "01", "-1", "1e3", SPACE + "1", "1.", ".5"]) {
      rejectsWith(() => decimalToBaseUnits(t, 6), "AMOUNT_FORM_INVALID");
    }
  });

  test("105 AMOUNT_OUT_OF_RANGE", () => {
    for (const t of ["0", "0.000000", "18446744073709.551616"]) {
      rejectsWith(() => decimalToBaseUnits(t, 6), "AMOUNT_OUT_OF_RANGE");
    }
  });
});

describe("checkFundingInstructions (SPEC.md 8.7)", () => {
  const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
  const expected = (): ExpectedFunding => ({
    programId: key(0x10),
    requester: key(0x11),
    config: key(0x12),
    bounty: key(0x13),
    usdcMint: key(0x14),
    bountyVault: key(0x15),
    requesterAta: key(0x16),
    data: createAndFundData(c1Args()),
  });
  const good = (): PlainInstruction => ({
    programId: key(0x10),
    keys: expectedFundingKeys(expected()),
    data: createAndFundData(c1Args()),
  });

  test("106 accepts the expected instruction", () => {
    checkFundingInstructions([good()], expected());
  });

  test("107 TX_INSTRUCTION_COUNT", () => {
    rejectsWith(() => checkFundingInstructions([], expected()), "TX_INSTRUCTION_COUNT");
    rejectsWith(
      () => checkFundingInstructions([good(), good()], expected()),
      "TX_INSTRUCTION_COUNT",
    );
  });

  test("108 TX_PROGRAM", () => {
    rejectsWith(
      () => checkFundingInstructions([{ ...good(), programId: key(0x20) }], expected()),
      "TX_PROGRAM",
    );
  });

  test("109 TX_ACCOUNTS: order, flags, count", () => {
    const withKeys = (keys: PlainAccountMeta[]): void =>
      rejectsWith(() => checkFundingInstructions([{ ...good(), keys }], expected()), "TX_ACCOUNTS");
    const swapped = good().keys.slice();
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    withKeys(swapped);
    withKeys(good().keys.map((k, i) => (i === 0 ? { ...k, isSigner: false } : k)));
    withKeys(good().keys.map((k, i) => (i === 2 ? { ...k, isWritable: false } : k)));
    withKeys(good().keys.slice(0, 8));
  });

  test("110 TX_DATA", () => {
    const data = createAndFundData(c1Args());
    data[100] = data[100]! ^ 0x01;
    rejectsWith(() => checkFundingInstructions([{ ...good(), data }], expected()), "TX_DATA");
  });
});
