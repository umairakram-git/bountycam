import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  canonicalise,
  sha256,
  merkleRoot,
  SpecError,
  eligibilityProfileHash,
} from "./index.js";
import type { EligibilityProfile } from "./index.js";

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
