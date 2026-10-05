# `@hackathon/shared` — Canonicalisation and Hashing Specification

**Status:** normative. Written before implementation (Session 5).
**Amended:** Session 5 part 2 — error model (§6), object and array shape rules
(§1.1, §1.7), byte-input rules (§2, §3.2). Amended before implementation.
**Amended:** Session 17 — section 8, the funding-path helpers, and section 6.5 (D121).
**Amended:** Session 18 — section 9, the acceptance-path helpers, and section 6.6
(D127).
**Amended:** Session 20 — section 11, the evidence manifest; section 6.7; section 10's opening
note (D141, D143, D144).
**Amended:** Session 21 — section 12, the attestation message; section 6.4's closing note
(D150).
**Amended:** Session 22 — section 13, the settlement-path helpers (D160).
**Scope:** `canonicalise`, `sha256`, `merkleRoot` as exported from
`packages/shared/src/index.ts`.

These three functions are computed independently by the mobile app, the API
server, and a standalone verifier. Any two implementations that follow this
spec must produce **byte-identical** output for every accepted input, and must
**reject** every input this spec rejects. Agreement on failure matters as much
as agreement on success: an input accepted by one implementation and rejected
by another is a spec violation.

Where this spec and any implementation disagree, the spec wins and the
implementation is buggy.

---

## 1. `canonicalise(value: unknown): string`

Produces the canonical JSON text of `value`. The result is a valid JSON
document per RFC 8259, encoded as UTF-8 when hashed (§2).

This spec follows **RFC 8785 (JSON Canonicalization Scheme)** except where a
deviation is stated. Deviations are marked **[DEVIATES from RFC 8785]** and
carry a reason.

### 1.1 Accepted value domain

Only these types are accepted, at any nesting depth:

| Type | Serialisation |
|---|---|
| `null` | `null` |
| `true` / `false` | `true` / `false` |
| integer number (§1.3) | shortest decimal integer |
| string (§1.4) | JSON string with minimal escaping |
| array | `[` elements joined by `,` `]` — no whitespace |
| plain object | `{` sorted `"key":value` pairs joined by `,` `}` — no whitespace |

No whitespace is ever emitted outside string contents (RFC 8785 §3.2.1).
*Why:* whitespace freedom is the most common source of hash divergence;
forbidding it entirely removes the freedom.

A **plain object** is accepted only if its prototype is `Object.prototype` or `null` and
every own property is a string-keyed, enumerable data property. An object with any
symbol-keyed property, any accessor (getter or setter) property, or any non-enumerable own
property is rejected (§1.7). Boxed primitives (`String`, `Number`, `Boolean` objects) are
non-plain and rejected.
*Why:* each excluded shape is either invisible to JSON or can yield a different value on a
different read, so accepting it would let two callers hash different structures silently.

An **array** is accepted only if `Array.isArray` is true, its prototype is
`Array.prototype`, and it is dense and carries nothing extra: every index from `0` to
`length - 1` is an own, enumerable data property, and no other own property exists
besides `length`. Any other array-like value — including `Array` subclass instances and
arrays with a `null` or otherwise altered prototype — is non-plain and rejected with
`NON_PLAIN_OBJECT` (§6.1). Holes and extra properties (named or symbol-keyed) are
rejected (§1.7).
*Why:* a hole is absent to some serialisers and a value to others, and extra properties
are invisible to JSON — both are silent-divergence hazards.

### 1.2 Key ordering

Object keys are sorted in ascending lexicographic order of their **UTF-16 code
units**, compared code unit by code unit; if one key is a prefix of another,
the shorter sorts first. This is RFC 8785 §3.2.3 exactly.
*Why:* it is locale-independent and matches RFC 8785, so any conformant JCS
library agrees; choosing UTF-8 byte order instead would silently diverge from
off-the-shelf implementations.

> **Warning for non-JavaScript implementations:** UTF-16 code unit order is
> **not** UTF-8 byte order for keys containing characters outside the Basic
> Multilingual Plane. A character ≥ U+10000 is two surrogates (0xD800–0xDFFF)
> in UTF-16 and therefore sorts *below* BMP characters in 0xE000–0xFFFF,
> whereas its UTF-8 bytes sort *above* all BMP characters. Rust and other
> UTF-8-native implementations must compare by UTF-16 code units explicitly.

Duplicate keys cannot arise from in-memory objects; an implementation that
canonicalises parsed JSON text must **reject** documents containing duplicate
keys in the same object.
*Why:* RFC 8259 leaves duplicate handling undefined, so parsers disagree on
which value survives.

### 1.3 Numbers — [DEVIATES from RFC 8785]

RFC 8785 serialises any IEEE-754 double using ECMAScript number-to-string
rules. This spec instead accepts **only integers** `n` with
`|n| ≤ 2^53 − 1` (JavaScript's safe-integer range) and **rejects every other
number** (§1.7).
*Why:* shortest-round-trip float formatting differs subtly across languages
and library versions (V8 vs. Ryū vs. Grisu), and per project decision D5 the
data model contains no floats — quantities that look fractional are strings.

Serialisation of an accepted integer:

- shortest decimal representation: no leading zeros, no decimal point, no
  exponent, no plus sign
- negative values carry a single leading `-`
- **negative zero serialises as `0`** — *why:* `-0` and `0` are the same
  mathematical value; two encodings of one value breaks uniqueness (this
  matches RFC 8785 / ECMAScript behaviour)
- integers with `|n| > 2^53 − 1` are rejected, not stringified — *why:* they
  cannot round-trip through a JavaScript `number`, so the phone and a
  64-bit-native verifier could silently hold different values; callers must
  pass them as strings

**Domain profile — quantities carried as strings** (normative for BountyCam
payloads, informative for the functions themselves). These profiles exist as
a direct consequence of the rejection above: because non-integer numbers are
rejected, every naturally fractional quantity must travel as a string, and a
string only hashes consistently if its exact form is pinned:

- **GPS coordinates:** decimal-degree strings with **exactly 7 digits after
  the decimal point**, e.g. `"-37.8136000"`, `"144.9631000"`. A single leading
  `-` for negative; integer part has no leading zeros except a single `0`
  before the point (`"0.0000000"`); no `+`, no exponent, no trailing
  whitespace. *Why 7:* ~1.1 cm at the equator, finer than any GPS fix, and a
  fixed count removes all formatting discretion from producers.
- **Token amounts:** base-unit integer strings (USDC has 6 decimals, so
  1 USDC = `"1000000"`). *Why:* integer base units are exact; decimal amounts
  reintroduce float formatting through the back door.

The canonicaliser does **not** validate these profiles — they are strings to
it. Producers are responsible for emitting them in profile form. The GPS profile's
validators and its producer are section 8.1, outside `canonicalise`.
*Why:* keeping domain validation out of the hash primitive keeps the primitive
pure and testable in isolation.

### 1.4 Strings and escaping

Strings serialise per RFC 8785 §3.2.2.2 (which is RFC 8259 minimal escaping):

- `"` → `\"` and `\` → `\\`
- `\b` (U+0008), `\t` (U+0009), `\n` (U+000A), `\f` (U+000C), `\r` (U+000D)
  use their two-character escapes
- every other C0 control character (U+0000–U+001F) escapes as `\u00xx` with
  **lowercase** hex digits
- **every other character is emitted literally** — no `\uXXXX` escapes for
  printable characters, no `\/` for solidus

*Why:* a given string has exactly one permitted encoding, so the hash is
unique. JSON often allows a choice between an escape sequence and the raw
character; this spec removes the choice with two rules:

1. **Control characters U+0000–U+001F always use the shortest escape form**:
   the two-character escapes for the five characters listed above, and the
   six-character escape with **lowercase** hex digits for the rest. (Raw form
   is not an option — RFC 8259 forbids unescaped control characters in
   strings.)
2. **Every other character is emitted raw**, never escaped — except `"` and
   `\`, which JSON requires escaped and which have exactly one escape form
   anyway.

Examples of prohibited encodings, each with its mandated form:

| Prohibited form | Mandated form | Rule |
|---|---|---|
| six-character escape for U+000A | two-character escape for newline | 1 |
| any other encoding of U+0001 | lowercase six-character escape | 1 |
| six-character escape for U+00E9 | the raw character é | 2 |
| surrogate-pair escape for U+1F998 | the raw character 🦘 | 2 |
| escaped solidus | the raw character / | 2 |

Strings containing **lone surrogates** (an unpaired code unit in
U+D800–U+DFFF) are rejected.
*Why:* lone surrogates have no valid UTF-8 encoding, so §2's byte encoding
would be implementation-defined. (RFC 8785 likewise requires well-formed
strings.)

### 1.5 Unicode normalisation

**None.** Code points are serialised exactly as given; no NFC/NFD/NFKC/NFKD
is applied. This matches RFC 8785 (which performs no normalisation).
*Why:* normalisation tables change across Unicode versions and differ across
platform libraries, which would make the hash depend on the runtime.
Consequence, stated openly: `"é"` (U+00E9) and `"é"` (U+0065 U+0301)
are **different strings with different hashes**. Producers that need equality
across composed forms must normalise before calling `canonicalise`.

### 1.6 null, undefined, and empty containers

- `null` → `null`
- `undefined` → **rejected, anywhere it appears** — including as an object
  property value. **[DEVIATES from `JSON.stringify`]**, which silently drops
  `undefined` properties. *Why:* silent omission lets two callers hash
  different structures without any error surfacing; rejection makes the
  disagreement loud at the source.
- empty object → `{}`; empty array → `[]`. *Why stated at all:* so no
  implementation is tempted to elide or null them.

### 1.7 Rejected outright

`canonicalise` must **throw** (never return, never substitute a default) for:

| Input | Why rejected |
|---|---|
| `NaN`, `+Infinity`, `-Infinity` | no JSON representation; RFC 8785 also excludes them |
| non-integer numbers (e.g. `1.5`) | float formatting is not portable (§1.3) |
| integers beyond ±(2^53 − 1) | cannot round-trip through a JS `number` (§1.3) |
| `BigInt` | no JSON representation; pass large integers as strings |
| `undefined` | silent-drop divergence (§1.6) |
| functions, symbols | not data |
| non-plain objects (note 1 below) | several plausible serialisations each |
| objects with symbol-keyed properties | invisible to JSON; silent omission (§1.1) |
| objects or arrays with accessor properties | a getter may differ per read (§1.1) |
| objects with non-enumerable own properties | skipped by enumeration; silent omission (§1.1) |
| arrays with non-enumerable indices | skipped by enumeration; silent omission (§1.1) |
| sparse arrays (holes) | a hole is absent to some serialisers, a value to others (§1.1) |
| arrays with extra own properties | invisible to JSON; silent omission (§1.1) |
| cyclic structures (note 3 below) | cannot terminate |
| lone surrogates in any string or key | no valid UTF-8 encoding (§1.4) |
| duplicate keys (when input is parsed JSON text) | parser-dependent survivor (§1.2) |
| nesting depth > 64 (note 2 below) | divergent stack-overflow behaviour |

For the TypeScript package, the thrown error class and per-row codes are defined in §6.

Note 1 — an object is **plain** only if its prototype is `Object.prototype` or `null`
(§1.1). `Date`, `Map`, `Set`, `RegExp`, typed arrays, class instances, and boxed
primitives (`String`, `Number`, `Boolean` objects) are all non-plain. An array is plain
only if `Array.isArray` is true and its prototype is `Array.prototype`; `Array` subclass
instances and null-prototype arrays are non-plain (§1.1). Each non-plain shape has
multiple plausible serialisations; forcing callers to convert to plain data makes the
choice explicit.

Note 2 — depth is counted as the number of nested containers: a top-level
scalar is depth 0, `{"a":[1]}` has depth 2. Depth exactly 64 is accepted.
The limit exists because one implementation must not overflow its stack
where another succeeds — agreement on failure is part of the spec.

Note 3 — a **cycle** is a container that is its own ancestor on the current traversal
path. Shared references that are not ancestors — the same container reached more than
once along different paths — are not cycles; they are accepted and serialised in full
at each occurrence.

Note 4 — stated limit: `Proxy` objects cannot be detected portably from inside
JavaScript. Canonicalising a `Proxy` is a caller error; neither the output nor the
error behaviour for a `Proxy` input is covered by this spec.

### 1.8 Recursion

Arrays and objects recurse with **identical rules at every depth**. There are
no top-level-only or depth-dependent behaviours.
*Why:* any depth-dependent special case doubles the test surface and invites
divergence in exactly the code paths tested least.

---

## 2. `sha256(bytes: Uint8Array): Uint8Array`

SHA-256 as specified in **FIPS 180-4**, no variations. Input is a byte
array; output is the raw 32-byte digest.

- **Input must be a `Uint8Array` instance.** Subclasses such as Node's `Buffer` are
  accepted. Exactly the bytes in the view are hashed: `length` bytes starting at
  `byteOffset` in the underlying buffer. Everything else is rejected — `ArrayBuffer`,
  `DataView`, `Uint8ClampedArray` and all other typed arrays, strings, and arrays of
  numbers.
  *Why:* near-miss byte types invite silent coercion or hash the wrong bytes; a
  `Uint8Array` view carries exactly the intended bytes and needs no interpretation.
- **String inputs must be UTF-8 encoded by the caller before hashing.** The
  encoder must not add a byte-order mark. A leading U+FEFF already present in
  a string is content: it is encoded (`EF BB BF`) and hashed, never stripped.
  *Why:* BOM stripping is a lossy transformation that some platform decoders
  apply and others do not; making the rule "bytes in, bytes hashed" removes
  the ambiguity. (`canonicalise` output can never begin with U+FEFF, so the
  case arises only for direct callers.)
- **Hex convention**, wherever a digest is rendered as a string (database
  rows, on-chain memos, logs, this spec's vectors): **lowercase**, no `0x`
  prefix, exactly 64 characters, zero-padded.
  *Why:* mixed-case or prefixed hex turns string comparison into a source of
  false mismatches; one form, everywhere.

---

## 3. `merkleRoot(hashes: Uint8Array[]): Uint8Array`

Computes a binary Merkle tree root over an **ordered** list of 32-byte
SHA-256 digests (the digests of the evidence items, as produced by §2).

### 3.1 Node hashing and domain separation

Following the RFC 6962 (Certificate Transparency) convention:

- **Leaf node:** `L(h) = sha256(0x00 ‖ h)` — the input digest is hashed
  again with a one-byte `0x00` prefix.
- **Internal node:** `I(left, right) = sha256(0x01 ‖ left ‖ right)` with a
  one-byte `0x01` prefix.

*Why the prefixes:* without distinct leaf/internal prefixes, a 64-byte
concatenation `left ‖ right` can be presented as a "leaf", letting an
attacker prove membership of an internal node — a second-preimage forgery.
The separation costs one byte per hash at spec time and is unfixable protocol
damage if omitted.

*Why leaves are hashed again rather than used directly:* the inputs are
already digests of evidence bytes; re-hashing under the `0x00` prefix places
every tree node behind domain separation, so no evidence digest can collide
with any node of the tree.

### 3.2 Tree construction

1. The input must be an array. Every element must be a `Uint8Array` instance
   (subclasses such as `Buffer` accepted; bytes-in-view rule per §2) whose view is
   exactly 32 bytes; otherwise **reject**.
   *Why:* a wrong-length or wrong-type input is always a caller bug (an unhashed
   payload or a hex string), and concatenating it would silently produce a
   valid-looking root.
2. Map inputs, in the order given, to leaf nodes via `L`. Order is
   significant and is never sorted by this function.
   *Why:* evidence order is meaningful to the policy; sorting here would hide
   caller mistakes and add a second place ordering is defined.
3. While more than one node remains: pair adjacent nodes left-to-right and
   combine each pair with `I(left, right)`, where **left is the
   lower-indexed node**.
   *Why stated:* swapped concatenation is the classic cross-implementation
   Merkle bug and is undetectable except by vector.
4. **Odd node count: the final unpaired node is promoted to the next level
   unchanged** (not duplicated). **[DEVIATES from Bitcoin's
   duplicate-last]** — *why:* duplication makes `[A, B, C]` and
   `[A, B, C, C]` hash to the same root (the ambiguity behind
   CVE-2012-2459); promotion, combined with §3.1 domain separation, keeps
   distinct lists distinct.
5. The remaining node is the root.

### 3.3 Edge cases

- **Empty list: rejected** (throw). *Why:* no valid evidence bundle is
  empty; a defined empty-root constant would let "hashed nothing" look like
  a healthy value deep inside a passing pipeline.
- **Single element:** `merkleRoot([h]) = L(h) = sha256(0x00 ‖ h)` — the
  leaf node itself, consistent with the general construction rather than a
  special case. *Why:* returning `h` unchanged would break domain
  separation for the commonest bundle size.

---

## 4. Test vectors

These five vectors are the conformance suite. An implementation passes when
it reproduces every canonical string byte-for-byte and every digest
hex-for-hex. All digests below were computed from raw terminal output, not
transcribed from memory. Hex is lowercase per §2.

### V1 — flat object, GPS domain profile, single-leaf root

Input (JS literal; note insertion order differs from output order):

```js
{ lon: "144.9631000", bounty_id: "42", lat: "-37.8136000" }
```

Canonical string:

```
{"bounty_id":"42","lat":"-37.8136000","lon":"144.9631000"}
```

- `sha256(utf8(canonical))`:
  `faa0b8a8c50d7cf835bfc0853cf940637c6408eaade5b90dc9df2c77d0d0cff3`
- `merkleRoot([that digest])` (exercises §3.3 single element):
  `2fed2c3c962d549f593a1e4c44670e4e3bbad3bf15326fc0f77d35d4f0b345f1`

### V2 — escaping, non-ASCII keys and values, key ordering, empty object

Input (JS literal; `NL` stands for the single character U+000A — per D31 the
escape form is not written literally here):

```js
{ z: null, "émoji": "🦘", note: "line1" + NL + "line2", a: [true, false, {}], _: "" }
```

Canonical string (75 bytes as UTF-8 with `BSN` replaced; `é` and `🦘` are
literal; `BSN` stands for the two characters U+005C U+006E — the newline's
two-character escape per §1.4; `é` U+00E9 sorts after `z` U+007A):

```
{"_":"","a":[true,false,{}],"note":"line1BSNline2","z":null,"émoji":"🦘"}
```

- `sha256(utf8(canonical))`:
  `a288f23950d5fb16f9d9e4e31a027f7d58e62c49560ca2ee29d91bc9fcf1e36e`

### V3 — integer edges: zero, negative zero, safe-integer bounds, empty array

Input:

```js
{ min: -9007199254740991, count: 0, neg_zero: -0, max: 9007199254740991, empty_list: [] }
```

Canonical string (note `neg_zero` serialises as `0`):

```
{"count":0,"empty_list":[],"max":9007199254740991,"min":-9007199254740991,"neg_zero":0}
```

- `sha256(utf8(canonical))`:
  `5896e68f0096d51f339cece666f84537536459c08226d49068a324cbd3a70edf`

### Shared leaves for V4 and V5

Each leaf digest is `sha256(utf8(name))` over the ASCII names `leaf-a`,
`leaf-b`, `leaf-c`:

| Leaf | Digest |
|---|---|
| `a` | `e9845d1809b292abbfa6e93b1fd1e7be6da0065d23af392017eecc0ab4d0ad0f` |
| `b` | `b2ff96642b087187598e416db9912019fb27ef02be1d0436fdc1ad7a3b28ae19` |
| `c` | `3f0c143edf62084b433fe2b16c48bd706a6260245b9f78f3c4a77f730dafc0d3` |

Leaf nodes (`L(h) = sha256(0x00 ‖ h)`):

| Node | Digest |
|---|---|
| `L(a)` | `d40a0e6f288c6f29ee4d01c5ede177f0e4452caf203e259b50865be002c73c3b` |
| `L(b)` | `76827801cb4c471c195edd8fb66bb78a99c9332ec7250695e0be94836cd96164` |
| `L(c)` | `af0cc79e6310820ae6cb42bfec39e40fca73274c7af63a1dd8c5dd61a99dcb0c` |

### V4 — two leaves (exercises concatenation order)

`merkleRoot([a, b]) = I(L(a), L(b)) = sha256(0x01 ‖ L(a) ‖ L(b))`:

```
9c9b47b435b4c8719bf98c8aa9c3840f5a4f986fcd28cb1b676cf1b8b078149f
```

If an implementation gets V4 wrong but the leaf nodes above right, its
concatenation order or internal prefix is wrong.

### V5 — three leaves (exercises odd-node promotion)

Level 0: `[L(a), L(b), L(c)]` → pair `(L(a), L(b))`, promote `L(c)`.
Level 1: `[I(L(a), L(b)), L(c)]` where `I(L(a), L(b))` is the V4 root.
Root: `I(I(L(a), L(b)), L(c))`:

```
95300cb3b0a94c0ac4373e23439a2990066f10ab53374cd73dadc4953a80e88c
```

If an implementation reproduces V4 but not V5, its odd-node handling is
wrong (most likely duplicating the last node instead of promoting it).

---

## 5. Conformance

An implementation of this spec must:

1. reproduce all five vectors exactly;
2. reject every input class in §1.7, §2 (wrong types), §3.2 step 1, and
   §3.3 (empty list) with an error — not a default, not a warning;
3. contain no configuration options affecting output. One input, one output,
   in every language, forever;
4. (TypeScript package only) throw `SpecError` carrying the §6 code for every
   rejection.

---

## 6. Error model (TypeScript package)

The TypeScript package exports one error class, `SpecError`, which extends `Error` and
carries a readonly `code` field naming the violated rule. Every rejection in this spec
throws `SpecError`. Codes are uppercase (project decision D20).

Codes are **normative for the TypeScript package only**. Any other implementation must
reject exactly the same inputs, but need not reproduce the codes.

### 6.1 canonicalise codes

| Code | Rejected input |
|---|---|
| `NON_FINITE_NUMBER` | NaN, positive or negative Infinity |
| `NON_INTEGER_NUMBER` | any finite number that is not an integer |
| `UNSAFE_INTEGER` | integers beyond the safe range (§1.3) |
| `BIGINT` | BigInt values |
| `UNDEFINED` | undefined, anywhere it appears |
| `FUNCTION_OR_SYMBOL` | function or symbol values |
| `NON_PLAIN_OBJECT` | non-plain objects, including boxed primitives (§1.7 note 1) |
| `SYMBOL_KEY` | an object with a symbol-keyed own property |
| `ACCESSOR_PROPERTY` | an accessor property on an object or array |
| `NON_ENUMERABLE_PROPERTY` | a non-enumerable own property or array index; `length` exempt |
| `ARRAY_HOLE` | a sparse array |
| `ARRAY_EXTRA_PROPERTY` | an array own property besides indices and `length` |
| `CYCLIC` | cyclic structures |
| `LONE_SURROGATE` | a lone surrogate in any string or key |
| `DEPTH_LIMIT` | nesting depth greater than 64 |

The duplicate-keys row of §1.7 has no code: it applies only to parsed JSON text (§1.2),
which this package cannot receive. A code that can never be thrown would only mislead.

### 6.2 sha256 and merkleRoot codes

| Code | Function | Rejected input |
|---|---|---|
| `NOT_BYTES` | `sha256` | input is not a `Uint8Array` instance (§2) |
| `NOT_AN_ARRAY` | `merkleRoot` | input is not an array |
| `EMPTY_LIST` | `merkleRoot` | the input array is empty (§3.3) |
| `ELEMENT_NOT_BYTES` | `merkleRoot` | an element is not a `Uint8Array` instance |
| `ELEMENT_NOT_32_BYTES` | `merkleRoot` | an element whose view is not exactly 32 bytes |

### 6.3 Check order

Traversal is depth-first. On entering any container, two checks run in a fixed,
normative order: the **cycle check first**, then the **depth check**. The cycle check
compares the entered container against the containers on the current traversal path
(note 3 of §1.7). The depth check throws `DEPTH_LIMIT` if the entered container is at
depth 65 or deeper (note 2 of §1.7: depth exactly 64 is accepted).

Consequences of the order:

- The deepest container entry at which any check runs is depth 65: the depth check
  throws there, so no container at depth 66 is ever entered.
- A cycle whose ancestor is re-entered at depth 65 or shallower throws `CYCLIC` — the
  cycle check runs before the depth check even at depth 65.
- A cycle whose ancestor would first be re-entered at depth 66 or deeper never closes:
  the traversal throws `DEPTH_LIMIT` at depth 65 first.
- Boundary, counted from the top level: a cycle through `n` distinct containers
  re-enters its ancestor at depth `n + 1`, so `n ≤ 64` throws `CYCLIC` and `n ≥ 65`
  throws `DEPTH_LIMIT`. A self-containing object (`n = 1`) re-enters at depth 2.
- General form: for a cycle of `n` containers whose first container sits below `P`
  non-cyclic ancestors, re-entry is at depth `P + n + 1`, so `P + n ≤ 64` throws
  `CYCLIC` and `P + n ≥ 65` throws `DEPTH_LIMIT`.

For every value, the plainness check — prototype, and `Array.isArray` for arrays (§1.1) —
runs before any own-property check. A non-plain value throws `NON_PLAIN_OBJECT` whatever
its properties; without this order, `RegExp` (own `lastIndex`) and boxed `String` (own
`length`) would also match `NON_ENUMERABLE_PROPERTY`. This order, like cycle-before-depth,
is normative.

For an input with several independent faults, or one fault matching more than one code,
which single code is thrown is **unspecified**; that a `SpecError` is thrown is the only
normative requirement. Test suites must not pin a specific code for such inputs. The
cycle-versus-depth and plainness-first orders above are the exceptions: they are
normative.

### 6.4 eligibilityProfileHash and eligibilityMessage codes

| Code | Function | Rejected input |
|---|---|---|
| `PROFILE_SHAPE_INVALID` | `eligibilityProfileHash` | a profile failing any §7.1 shape rule |
| `PROFILE_ID_INVALID` | `eligibilityProfileHash` | `profile_id` outside the §7.2 format |
| `MESSAGE_FIELD_NOT_BYTES` | `eligibilityMessage` | a byte field that is not a `Uint8Array` |
| `MESSAGE_FIELD_LENGTH` | `eligibilityMessage` | a byte field not at its MESSAGES.md §4 width |
| `MESSAGE_FIELD_RANGE` | `eligibilityMessage` | a numeric field out of range; see below |

`MESSAGE_FIELD_RANGE` covers `deploymentId` outside 0 to 255, `requiredAssurance` outside 0 to
`MAX_ASSURANCE_LEVEL` (4), and `expiresAt` that is not a `bigint` within `i64`.

`eligibilityMessage` checks fields in MESSAGES.md §4 offset order, each fully before the
next; the first failure wins. `attestationMessage` (section 12) uses the same three codes and
the same order rule.

### 6.5 Funding-path helper codes

Section 8, Session 17. Each code is listed under the helper that owns it.

| Code | Function | Rejected input |
|---|---|---|
| `GPS_FORM_INVALID` | `gpsToScaled` | a value failing POLICY.md section 5 rules 1 to 6 |
| `GPS_NOT_FINITE` | `formatCoordinate` | NaN or an infinity |
| `GPS_OUT_OF_RANGE` | `formatCoordinate` | a formatted value failing its axis |
| `GPS_PAIR_INVALID` | `parseCoordinatePair` | text not of the section 8.1 pair form |
| `ASSURANCE_OUT_OF_RANGE` | `admissibleProfileId` | anything but an integer 0 to 4 |
| `UUID_FORM_INVALID` | `uuidBytes` | anything but the section 8.3 form |
| `FUND_FIELD_NOT_BYTES` | `createAndFundData` | a byte field that is not a `Uint8Array` |
| `FUND_FIELD_LENGTH` | `createAndFundData` | a byte field not at its section 8.4 width |
| `FUND_FIELD_RANGE` | `createAndFundData` | a numeric field outside section 8.4 |
| `CREATED_SHAPE_INVALID` | `verifyCreatedBounty` | step 1 |
| `CREATED_HASH_MISMATCH` | `verifyCreatedBounty` | step 2 |
| `CREATED_CONSTANT_MISMATCH` | `verifyCreatedBounty` | step 3 |
| `CREATED_ENVIRONMENT_MISMATCH` | `verifyCreatedBounty` | step 4 |
| `CREATED_FIELD_MISMATCH` | `verifyCreatedBounty` | step 5 |
| `AMOUNT_FORM_INVALID` | `decimalToBaseUnits` | text or `decimals` outside section 8.6 |
| `AMOUNT_OUT_OF_RANGE` | `decimalToBaseUnits` | zero, or above the u64 maximum |
| `TX_INSTRUCTION_COUNT` | `checkFundingInstructions` | step 1 |
| `TX_PROGRAM` | `checkFundingInstructions` | step 2 |
| `TX_ACCOUNTS` | `checkFundingInstructions` | step 3 |
| `TX_DATA` | `checkFundingInstructions` | step 4 |

`parseCoordinatePair` also throws `GPS_OUT_OF_RANGE`, from the `formatCoordinate` call it
makes for each part.

### 6.6 Acceptance-path helper codes

Section 9, Session 18. Each code is listed under the helper that owns it.

| Code | Function | Rejected input |
|---|---|---|
| `ACCEPT_FIELD_RANGE` | `acceptData` | a value outside section 9.1 |
| `ED25519_FIELD_NOT_BYTES` | `ed25519InstructionData` | a field that is not a `Uint8Array` |
| `ED25519_FIELD_LENGTH` | `ed25519InstructionData` | a field not at its section 9.2 width |
| `VOUCHER_SHAPE_INVALID` | `checkVoucher` | step 1 |
| `VOUCHER_AUTHORITY_MISMATCH` | `checkVoucher` | step 2 |
| `VOUCHER_FIELD_MISMATCH` | `checkVoucher` | step 3 |
| `ASSIGNED_SHAPE_INVALID` | `verifyAssignedPolicy` | steps 1 and 3 |
| `ASSIGNED_HASH_MISMATCH` | `verifyAssignedPolicy` | step 2 |

`checkAcceptInstructions` reuses the four `TX_` codes of section 6.5, with the same meanings.

### 6.7 Evidence manifest codes

Section 11, Session 20.

| Code | Function | Rejected input |
|---|---|---|
| `MANIFEST_SHAPE` | `checkEvidenceManifest` | not an object, a wrong key set, a wrong JSON type |
| `MANIFEST_ITEMS` | `checkEvidenceManifest` | no items, more than 20, a repeated requirement id |
| `MANIFEST_FIELD` | `checkEvidenceManifest` | a value failing its section 11.2 or 11.3 rule |
| `STATEMENT_INPUT_INVALID` | `evidenceStatement` | a malformed bounty id or root |
| `ACCURACY_INVALID` | `manifestAccuracy` | non-finite, negative, or above 100000 |
| `CHUNK_INVALID` | `sha256Chunked` | a chunk size that is not a positive safe integer |

`evidenceLeaves` and `evidenceRoot` throw `checkEvidenceManifest`'s codes; `sha256Chunked` also
throws section 6.2's `NOT_BYTES`.

---

## 7. Eligibility profiles

An eligibility profile is the committed rule set a Scout must satisfy to accept a
bounty (D69, D84). The bounty account stores its 32-byte hash, and both binary
signed messages carry that hash (MESSAGES.md sections 3 and 4), so the derivation
below is on the money path and is normative.

This section defines the object, the id format and the derivation only. Which
profile ids exist, what each one requires operationally, and which is admissible
for a given `required_assurance` are the registry, and the registry lives in
`apps/api/POLICY.md`.

### 7.1 The profile object

A version 1 profile is a plain object with exactly three keys, shown here in
canonical order (section 1.2):

| Key | Type | Rule |
|---|---|---|
| `domain_tag` | string | exactly `BOUNTYCAM_ELIGIBILITY_PROFILE_V1` |
| `profile_id` | string | the section 7.2 format |
| `requires_sgt` | boolean | whether a Seeker Genesis Token is required |

Exactly three keys. A profile carrying a fourth key, or missing one, is rejected;
it is not canonicalised and no hash is produced.

The field set is fixed for version 1. A profile needing a rule these three keys
cannot express — a completed-bounty minimum, an identity check, a credential — is
a new `domain_tag` version with its own object, never a fourth key here. This
keeps every version 1 profile the same shape, so a hash mismatch always means a
value differed and never that a schema drifted.

The domain tag is a field rather than a prefix, for the reason section 3.2 gives
for the policy hash.

### 7.2 The profile id format

One to forty characters. Uppercase ASCII letters, ASCII digits and the underscore
only. The id must end with the two characters `_V` followed by one or more ASCII
digits, and must not begin with an underscore or a digit.

`BASE_V1` and `A4_SEEKER_V1` satisfy it. `base_v1`, `BASE`, `BASE_V`, `_BASE_V1`
and `1_BASE_V1` do not.

The trailing version is the point of the format. A profile whose meaning changes
takes a new id, so the old id continues to name what it always named. The hash
enforces this independently — see section 7.5 — but a reader inspecting a stored
policy sees the version without computing anything.

### 7.3 Derivation

```
eligibilityProfileHash(profile) = sha256(utf8(canonicalise(profile)))
```

`canonicalise` is section 1, `sha256` is section 2, and the UTF-8 encoding adds no
byte-order mark. The result is the raw 32 bytes, not hex: the bounty account and
both binary messages carry raw bytes (MESSAGES.md section 2).

The TypeScript package exports `eligibilityProfileHash`. It validates the object
against section 7.1 and the id against section 7.2 before canonicalising, and
throws `SpecError` with `PROFILE_SHAPE_INVALID` or `PROFILE_ID_INVALID`
respectively (section 6). Validation precedes canonicalisation, so a malformed
profile never reaches the hash.

### 7.4 Vectors

Both registry profiles, with their canonical text, byte length and hash. Hex is
lowercase per section 2.

**P1 — `BASE_V1`**

```
{"domain_tag":"BOUNTYCAM_ELIGIBILITY_PROFILE_V1","profile_id":"BASE_V1","requires_sgt":false}
```

- length: 93 bytes as UTF-8
- `eligibilityProfileHash`:
  `0d2a8920d85f17637cff555ef00869418767b4de9cb72cc553c8944ccfd0deb9`

**P2 — `A4_SEEKER_V1`**

```
{"domain_tag":"BOUNTYCAM_ELIGIBILITY_PROFILE_V1","profile_id":"A4_SEEKER_V1","requires_sgt":true}
```

- length: 97 bytes as UTF-8
- `eligibilityProfileHash`:
  `a1bcc81f8046565564915d5e7eead4cc1108003100c29f453de9325bd2198cbe`

Provenance, stated because it matters: the two hashes above were computed while
this section was written, by a standalone script, not by this package. The inputs
are ASCII, need no escaping and are already in canonical key order, so a
conforming canonicaliser cannot produce different text — but that is an argument,
not a measurement. The implementing session reproduces both with the package's
own `canonicalise` and `sha256`. If it produces different values, the package is
right and this section is wrong: amend the vectors, do not amend the code.

### 7.5 Why the contents are hashed rather than the id

Hashing the id alone would commit to a label. Redefining what that label required
would then change what every already-funded bounty meant, with no hash anywhere
changing — the exact failure recorded against the A4 rung in Session 8, where the
integer sat inside the hashed policy and the meaning of the integer did not.

Hashing the object commits to the meaning. Changing `requires_sgt` for an existing
id yields a different hash, which no longer matches the hash stored on any bounty
funded under the old definition, so every voucher reconstruction for those
bounties fails loudly at `VerificationMessageMismatch` rather than silently
succeeding under new rules.

---

## 8. Funding-path helpers

**Status:** normative, Session 17 (P1, D121). Written before implementation.

Each helper below is pure, has no platform dependency, and sits on the path that turns
a requester's input into a funded escrow. The phone and the API both need some of them;
the rest are needed by the phone alone, and the phone has no test runner. Placing them
here gives one implementation, and a suite that shows each negative red before the gate.
None of them changes `canonicalise`, `sha256`, `merkleRoot`, or any vector in sections 4
and 7.

Every rejection throws `SpecError` with a section 6.5 code. Money and time values bound
for the chain are `bigint`. Byte fields are `Uint8Array`, exactly as wide as stated.
Returned byte arrays are fresh copies, never views over an input.

### 8.1 The GPS profile

The rules are `apps/api/POLICY.md` section 5, rules 1 to 7, unchanged. This section is
their only implementation (D61, closed by D121); POLICY.md section 5 remains their
statement.

- `isValidLat(value: string): boolean` is true exactly when `value` passes rules 1 to 7
  with the latitude range, -90 to 90.
- `isValidLon(value: string): boolean` is the same with the longitude range, -180 to 180.
  Both return false for a non-string. Neither throws.
- `gpsToScaled(value: string): bigint` returns the value times ten million, exactly: the
  full stop removed and the signed digits parsed. It requires rules 1 to 6 only, because
  the snap of POLICY.md section 9 uses it; otherwise `GPS_FORM_INVALID`.
- `formatCoordinate(degrees: number, axis: "lat" | "lon"): string` is the producer. In
  order: a non-finite `degrees` is `GPS_NOT_FINITE`; the value is formatted with
  ECMAScript `Number.prototype.toFixed` and seven fraction digits; a result that is a
  hyphen-minus followed by `0.0000000` becomes `0.0000000` (rule 6); the result must then
  pass the axis's rules 1 to 7, else `GPS_OUT_OF_RANGE`. A magnitude of 1e21 or more
  formats in exponent form and so fails as `GPS_OUT_OF_RANGE`, which it is.
- `parseCoordinatePair(text: string): { lat: string; lon: string }` reads a pair pasted
  from a map app, `lat, lon` (D122). In order: remove leading and trailing space, tab,
  line feed and carriage return; split on the comma, U+002C, which must occur exactly
  once; remove the same characters around each part; each part must be an optional
  hyphen-minus, one or more ASCII digits, and optionally a full stop followed by one or
  more ASCII digits. Any failure so far is `GPS_PAIR_INVALID`. Each part is then
  converted with `Number` and passed to `formatCoordinate` with its axis, which may throw
  `GPS_OUT_OF_RANGE`.

Rounding is `toFixed`'s: the decimal nearest the double's exact value, and the larger
of two at a tie. A producer in another language must reproduce that. The policy hash
commits to the string, so no consumer ever re-derives it from a double.

### 8.2 The eligibility profile registry

- `ELIGIBILITY_PROFILES: ReadonlyMap<string, EligibilityProfile>` holds exactly the two
  rows of POLICY.md section 2.5, as the section 7.4 objects. `eligibilityProfileHash`
  over each reproduces P1 and P2.
- `admissibleProfileId(requiredAssurance: number): string` returns `BASE_V1` for 0 to 3
  and `A4_SEEKER_V1` for 4. Any other value, including a non-integer or a non-number, is
  `ASSURANCE_OUT_OF_RANGE`.

POLICY.md section 2.5 stays the registry of record. This map is its only implementation:
`apps/api` imports it and keeps no copy. The phone needs it because the funding
instruction carries the profile hash, and SECURITY.md section 3 forbids taking that value
from a server response.

### 8.3 `uuidBytes(uuid: string): Uint8Array`

The input is the lowercase hyphenated form: groups of 8, 4, 4, 4 and 12 lowercase hex
digits separated by hyphen-minus, 36 characters, any version and variant. Anything else,
including a non-string, is `UUID_FORM_INVALID`. The output is 16 bytes, each the value of
one pair of hex digits, pairs taken in written order with the hyphens skipped.

This is the conversion D93 uses for `failed_requirement_id` and D117 uses for
`bounty_id`.

**Vector U1.** `0f8fad5b-d9cb-469f-a165-70867728950e` gives
`0f8fad5bd9cb469fa16570867728950e`.

### 8.4 `createAndFundData(args: FundingArgs): Uint8Array`

The instruction data of the escrow's `create_and_fund` (`programs/escrow/SPEC.md` section
7.2), 121 bytes. Integers are little-endian.

| Offset | Width | Field | Encoding |
|---|---|---|---|
| 0 | 8 | discriminator | `51f153b313cba740` |
| 8 | 16 | `bountyId` | raw |
| 24 | 8 | `rewardAmount` | u64 |
| 32 | 32 | `policyHash` | raw |
| 64 | 32 | `eligibilityProfileHash` | raw |
| 96 | 1 | `requiredAssurance` | u8 |
| 97 | 8 | `acceptanceWindowSecs` | i64 |
| 105 | 8 | `completionWindowSecs` | i64 |
| 113 | 8 | `reviewWindowSecs` | i64 |

The discriminator is the first 8 bytes of `sha256` over the UTF-8 text
`global:create_and_fund`, Anchor's rule; the committed IDL carries the same 8 bytes.

Fields are checked in offset order, each fully before the next; the first failure wins.
A byte field that is not a `Uint8Array` is `FUND_FIELD_NOT_BYTES`; one of the wrong width
is `FUND_FIELD_LENGTH`. `rewardAmount` must be a `bigint` from 1 to 2 to the power 64
minus 1; `requiredAssurance` an integer from 0 to 4; the three windows `bigint` values
from 1 to 2592000, 2592000 and 86400 respectively. Anything else is `FUND_FIELD_RANGE`.
These ranges repeat the program's checks 1 to 5, so a value the program would refuse
never reaches a wallet. They are not the 60-second product minimums of POLICY.md
section 2.1, which the server enforces at creation.

**Vector C1.** `bountyId` U1; `rewardAmount` 5000000; `policyHash` the POLICY.md
section 13.1 V1 hash; `eligibilityProfileHash` P1; `requiredAssurance` 3; windows 86400,
7200 and 3600 — the arguments V1 yields under section 8.5. Output, 121 bytes, shown as
hex wrapped at 64 characters (display only):

```
51f153b313cba7400f8fad5bd9cb469fa16570867728950e404b4c0000000000
711175ab7b0ed6107e2a0f5510c07813d5c1771e4e934574f145615a894a253b
0d2a8920d85f17637cff555ef00869418767b4de9cb72cc553c8944ccfd0deb9
038051010000000000201c000000000000100e000000000000
```

`sha256` of the output:
`43f757e67d6c06b5808bd316a752f182ec7f2b0623af72c303d25b7a54b0b714`.

Provenance, as for section 7.4: computed by a standalone script while this section was
written, and re-computed by the apply script that committed it. The implementing session
reproduces it with the package. The first real funding (Session 17) is the independent
check: a wrong encoding fails on chain.

### 8.5 `verifyCreatedBounty(response: unknown, expected): FundingArgs`

POLICY.md section 3.5 as one function. `response` is the parsed body of the owner view
(POLICY.md section 8.2) from `POST /bounties` or `GET /bounties/:id`. `expected` holds
`cluster`, `settlementMint`, `title`, `category`, and `policy`: the ten request-source
fields of POLICY.md section 2.1 as the client sent them, requirement items carrying only
`prompt`, `required` and `type`.

Steps, in order; the first failure wins.

1. **Shape**, else `CREATED_SHAPE_INVALID`. `response` is a plain object. `id` is in the
   section 8.3 form. `title` and `category` are strings. `state` is exactly `DRAFT`.
   `policy_hash` is 64 lowercase hex characters. `policy` is a plain object with exactly
   the sixteen POLICY.md section 2.1 keys, each of its section 2.1 type: the four integer
   fields safe integers, `reward_amount` in the POLICY.md section 6.1 form, `salt` 64
   lowercase hex characters. `evidence_requirements` is an array whose items each have
   exactly `id`, `prompt`, `required` and `type`, with `id` in the section 8.3 form and no
   two alike. Other keys of `response` are ignored; nothing reads them.
2. **Hash**, else `CREATED_HASH_MISMATCH`. `sha256` over the UTF-8 bytes of
   `canonicalise(policy)` equals the bytes of `policy_hash`. A `SpecError` from
   `canonicalise` is `CREATED_SHAPE_INVALID`.
3. **Constants**, else `CREATED_CONSTANT_MISMATCH`: `chain` is `solana`, `domain_tag` is
   `BOUNTYCAM_POLICY_V1`, `fee_amount` is `0`.
4. **Environment**, else `CREATED_ENVIRONMENT_MISMATCH`: `cluster` and `settlement_mint`
   equal `expected`'s.
5. **Request fields**, else `CREATED_FIELD_MISMATCH`: `title`, `category` and each of the
   ten request fields strictly equal `expected`'s; `evidence_requirements` has the same
   length, and each item's `prompt`, `required` and `type` equal the item at the same
   index. The registry must hold `eligibility_profile_id`.
6. **Return** `FundingArgs`: `bountyId` is `uuidBytes(id)`; `rewardAmount` is
   `reward_amount` as a `bigint`; `policyHash` the bytes of `policy_hash`;
   `eligibilityProfileHash` is `eligibilityProfileHash` of the registry object for
   `eligibility_profile_id`; `requiredAssurance` as given; `acceptanceWindowSecs`,
   `completionWindowSecs` and `reviewWindowSecs` are `acceptance_window_seconds`,
   `completion_window_seconds` and `challenge_window_seconds` as `bigint` (D72).

`createAndFundData` takes the return value unchanged. So the funding transaction's values
come only from an object that passed steps 1 to 5 (POLICY.md sections 3.5 and 6.3).
Step 5 is the one that catches a tampered object carrying a self-consistent hash.

### 8.6 `decimalToBaseUnits(text: string, decimals: number): string`

The requester types a USDC amount; the policy needs a base-unit string (section 1.3, and
POLICY.md section 6.1). `decimals` must be an integer from 0 to 18. `text` must be one or
more ASCII digits with no leading zero unless the integer part is exactly `0`, optionally
followed by a full stop and one to `decimals` ASCII digits. No sign, whitespace, exponent
or grouping. Either failure is `AMOUNT_FORM_INVALID`.

The result is the integer part times 10 to the power `decimals`, plus the fraction padded
on the right with zeros, written without leading zeros. It is computed with `bigint` or
digit strings, never a double. A result of zero, or above 2 to the power 64 minus 1, is
`AMOUNT_OUT_OF_RANGE`.

### 8.7 `checkFundingInstructions(instructions, expected): void`

SECURITY.md section 3, applied to the funding transaction. `instructions` is the
transaction's instruction list as plain values, each
`{ programId, keys: { pubkey, isSigner, isWritable }[], data }` with 32-byte keys.
`expected` holds `programId`, `requester`, `config`, `bounty`, `usdcMint`, `bountyVault`,
`requesterAta`, all 32 bytes, and `data`, the `createAndFundData` output.

1. Exactly one instruction, else `TX_INSTRUCTION_COUNT`. A second instruction of any
   kind fails, Compute Budget included: this transaction needs none, and the allowlist is
   the list of what it needs.
2. `programId` equals `expected.programId`, else `TX_PROGRAM`.
3. Exactly these nine keys, in this order, with these flags, else `TX_ACCOUNTS`:

| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | `requester` | yes | yes |
| 1 | `config` | no | no |
| 2 | `bounty` | no | yes |
| 3 | `usdcMint` | no | no |
| 4 | `bountyVault` | no | yes |
| 5 | `requesterAta` | no | yes |
| 6 | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | no | no |
| 7 | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | no | no |
| 8 | `11111111111111111111111111111111` | no | no |

   Rows 6 to 8 are the Token, Associated Token and System programs, compiled as
   constants. The order and flags are the program's account struct and its IDL.
4. `data` equals `expected.data` byte for byte, else `TX_DATA`.

Outside this check, stated: the fee payer and blockhash sit in the message, not in an
instruction; the phone sets the fee payer to the requester (`apps/mobile/FUNDING.md`). A
wallet may add instructions of its own after the phone hands the transaction over. That
is the wallet's act, and the program still enforces every amount.

### 8.8 Tests

The package's existing test file. The D36 gate becomes `tests 110, pass 110, fail 0`.
Each negative test is shown red before the gate by a scripted mutation of the check it
names, which must fail exactly that test (HANDOFF.md Working rules).

81. `isValidLat` and `isValidLon` accept: lat `0.0000000`, `90.0000000`, `-90.0000000`,
    `-33.8688197`; lon `180.0000000`, `-180.0000000`, `151.2092955`.
82. Both reject form failures: six and eight fraction digits, a leading zero, a plus
    sign, `-0.0000000`, an exponent, a leading space, the Arabic-Indic digit one (U+0661)
    in place of `1`, the empty string, and the number 1.
83. Range failures: lat `90.0000001` and `-90.0000001`; lon `180.0000001` and
    `-180.0000001`.
84. `gpsToScaled`: `-33.8688197` gives -338688197; `0.0000000` gives 0; `180.0000000`
    gives 1800000000; six fraction digits is `GPS_FORM_INVALID`.
85. `formatCoordinate`: -33.8688197 lat gives `-33.8688197`; 151.2092955 lon gives
    `151.2092955`; 0 and negative zero give `0.0000000`; -0.00000004 lat gives
    `0.0000000`; 90 lat gives `90.0000000`; -179.99999996 lon gives `-180.0000000`.
86. `formatCoordinate` rejects: NaN and Infinity, `GPS_NOT_FINITE`; 90.00000006 lat,
    180.1 lon and 1e21 lat, `GPS_OUT_OF_RANGE`.
87. `parseCoordinatePair` accepts `-33.8688197, 151.2092955`, the same without the
    space, the same padded with spaces and with a lat of `-33.86881970000001`, and
    `-33, 151`, giving `-33.0000000` and `151.0000000`.
88. It rejects, as `GPS_PAIR_INVALID`: the empty string, a single number, three numbers,
    letters, an exponent, a plus sign, `.5, 2` and `1., 2`; and as `GPS_OUT_OF_RANGE`:
    `91, 0` and `0, 181`.
89. The registry holds exactly two ids, whose hashes are P1 and P2.
90. `admissibleProfileId`: 0 to 3 give `BASE_V1`, 4 gives `A4_SEEKER_V1`; 5, -1, 1.5
    and the string `1` are `ASSURANCE_OUT_OF_RANGE`.
91. `uuidBytes` reproduces U1 and returns a fresh 16-byte array.
92. `uuidBytes` rejects: upper case, no hyphens, braces, 35 characters, a non-string.
93. `createAndFundData` reproduces C1.
94. The discriminator equals the first 8 bytes of the package's `sha256` over
    `global:create_and_fund`.
95. `FUND_FIELD_RANGE`: reward 0 and 2 to the power 64; reward as a number; assurance 5
    and -1; each window at 0 and one above its ceiling.
96. `FUND_FIELD_LENGTH` for a 15-byte `bountyId`, a 31-byte `policyHash` and a 33-byte
    `eligibilityProfileHash`; `FUND_FIELD_NOT_BYTES` for a `policyHash` given as an array
    of numbers.
97. `verifyCreatedBounty` accepts a response carrying `id` U1, title `Storefront check`,
    category `Retail`, state `DRAFT`, `policy_hash` V1 and `policy` V1, against V1's own
    request fields, cluster `devnet` and mint `11111111111111111111111111111111`; its
    return value, given to `createAndFundData`, reproduces C1.
98. `CREATED_SHAPE_INVALID`: `salt` removed; state `AVAILABLE`; two requirements with
    one id.
99. `CREATED_HASH_MISMATCH`: the last digit of `policy_hash` changed.
100. `CREATED_CONSTANT_MISMATCH`: `fee_amount` `1`, `policy_hash` recomputed to match.
101. `CREATED_ENVIRONMENT_MISMATCH`: expected cluster `mainnet-beta`.
102. `CREATED_FIELD_MISMATCH`: `reward_amount` `50000000` with a recomputed,
     self-consistent hash — the case POLICY.md section 3.5 step 3 exists for.
103. `decimalToBaseUnits` with 6 decimals: `10`, `10.5`, `0.000001` and
     `18446744073709.551615` give `10000000`, `10500000`, `1` and
     `18446744073709551615`.
104. `AMOUNT_FORM_INVALID`: `0.0000001`, `01`, `-1`, `1e3`, a leading space, `1.` and
     `.5`.
105. `AMOUNT_OUT_OF_RANGE`: `0`, `0.000000` and `18446744073709.551616`.
106. `checkFundingInstructions` accepts the expected instruction for C1 over fixed test
     keys.
107. `TX_INSTRUCTION_COUNT`: zero instructions, and two.
108. `TX_PROGRAM`: another program id.
109. `TX_ACCOUNTS`: keys 1 and 2 swapped; the requester not a signer; the bounty not
     writable; eight keys.
110. `TX_DATA`: one byte of `data` changed.

---

## 9. Acceptance-path helpers

**Status:** normative, Session 18 (P2, D127). Written before implementation.

These helpers carry a Scout from a voucher to a signed `accept`, and from an accepted
bounty to its exact location. The section 8 preamble applies unchanged: pure, no platform
dependency, `SpecError` with a section 6.6 code, `bigint` for chain values, fresh byte arrays.
None of them changes a vector in sections 4 and 7 or in MESSAGES.md.

### 9.1 `acceptData(expiresAt: bigint, verificationIndex: number): Uint8Array`

The `accept` instruction data, 18 bytes (escrow SPEC section 7.4):

| Bytes | Content |
|---|---|
| 0 to 7 | discriminator: the first 8 bytes of `sha256` over `global:accept` |
| 8 to 15 | `expiresAt`, little-endian signed 64-bit |
| 16 to 17 | `verificationIndex`, little-endian unsigned 16-bit |

`expiresAt` must be a `bigint` within the signed 64-bit range, and `verificationIndex` an
integer from 0 to 65535. Else `ACCEPT_FIELD_RANGE`.

Vector A1: `expiresAt` 1759000000 and index 0 give
`419646d885066b04c035d868000000000000`. The discriminator is `419646d885066b04`.

### 9.2 `ed25519InstructionData(authority, signature, message): Uint8Array`

The native ed25519 instruction's data in the one shape escrow SPEC section 6.1 accepts: 16
header bytes, then the 32-byte `authority`, the 64-byte `signature` and the `message`. Total
length 112 plus the message length.

| Bytes | Value |
|---|---|
| 0 | 1, the signature count |
| 1 | 0, padding |
| 2 to 3 | 48, the signature offset |
| 4 to 5 | 65535, the signature instruction index |
| 6 to 7 | 16, the public key offset |
| 8 to 9 | 65535, the public key instruction index |
| 10 to 11 | 112, the message offset |
| 12 to 13 | the message length |
| 14 to 15 | 65535, the message instruction index |

Every offset is little-endian unsigned 16-bit. A field that is not a `Uint8Array` is
`ED25519_FIELD_NOT_BYTES`. `authority` other than 32 bytes, `signature` other than 64, or a
message empty or longer than 65423 bytes is `ED25519_FIELD_LENGTH`.

Vector D1: MESSAGES.md vector ELI-01's message and signature, under the test eligibility
public key `30bc4580…9474` (`vectors.json`), give 324 bytes whose first 16 are
`01003000ffff1000ffff7000d400ffff`.

### 9.3 `checkVoucher(voucher, expected): void`

Checks a voucher from `POST /bounties/:id/voucher` (ELIGIBILITY.md section 3) before the
Scout signs anything. `voucher` holds `message`, `signature` and `authority` as bytes, decoded
by the caller, and `expiresAt` as a `bigint`. `expected` holds `programId`, `deploymentId`,
`bountyId`, `scout`, `policyHash`, `eligibilityProfileHash`, `requiredAssurance` and
`authority`.

Steps in order; the first failure wins.

1. **Shape**, else `VOUCHER_SHAPE_INVALID`: `message` 212 bytes, `signature` 64 bytes,
   `authority` 32 bytes, each a `Uint8Array`; `expiresAt` a `bigint` within the signed 64-bit
   range.
2. **Authority**, else `VOUCHER_AUTHORITY_MISMATCH`: `authority` equals `expected.authority`.
3. **Message**, else `VOUCHER_FIELD_MISMATCH`: `message` equals `eligibilityMessage` built
   from `expected`'s fields, `requester` taken from bytes 75 to 106 of `message` itself, and
   `expiresAt`.

Not checked, and stated as such. The requester field: the phone does not hold the requester's
wallet, and the program reconstructs it from the account. The signature: the native verifier
checks it, and a bad one costs a failed transaction's fee and moves no money.

### 9.4 `checkAcceptInstructions(instructions, expected): void`

SECURITY.md section 3, applied to the accept transaction. `instructions` is as section 8.7.
`expected` holds `programId`, `scout`, `config` and `bounty` (32 bytes each), and the checked
voucher's `authority`, `signature`, `message` and `expiresAt`.

1. Exactly two instructions, else `TX_INSTRUCTION_COUNT`.
2. The first instruction's program is the native ed25519 program,
   `Ed25519SigVerify111111111111111111111111111`, and the second's is `expected.programId`.
   Else `TX_PROGRAM`.
3. The first carries no keys. The second carries exactly these four, in this order, with
   these flags. Else `TX_ACCOUNTS`.

| # | Account | Signer | Writable |
|---|---|---|---|
| 0 | `scout` | yes | yes |
| 1 | `config` | no | no |
| 2 | `bounty` | no | yes |
| 3 | `Sysvar1nstructions1111111111111111111111111` | no | no |

4. The first's data equals `ed25519InstructionData(authority, signature, message)`, and the
   second's equals `acceptData(expiresAt, 0)`. Else `TX_DATA`.

The order is fixed: the ed25519 instruction is at index 0, so the verification index is 0.
Row 0 is writable because the Scout pays the fee, and a fee payer is writable in every
transaction; decoding the wire bytes reports it so. The program declares the Scout a
signer only and accepts the added writable flag (D128).
The fee payer and wallet-added instructions are outside this check, as section 8.7 states.

### 9.5 `verifyAssignedPolicy(response: unknown, expectedPolicyHash: Uint8Array)`

Returns `{ lat, lon }`, the exact location strings. `response` is the parsed assigned-Scout
view (POLICY.md section 16.4). `expectedPolicyHash` is 32 bytes: the voucher's policy hash
when the phone holds it, otherwise the bytes of the view's own `policy_hash` (D127).

1. **Shape**, else `ASSIGNED_SHAPE_INVALID`: `response` is a plain object; `policy_hash` is
   64 lowercase hex characters; `policy` is a plain object. A `SpecError` from `canonicalise`
   in step 2 is also this code.
2. **Hash**, else `ASSIGNED_HASH_MISMATCH`: `sha256` over the UTF-8 bytes of
   `canonicalise(policy)` equals both `expectedPolicyHash` and the bytes of `policy_hash`.
3. **Location**, else `ASSIGNED_SHAPE_INVALID`: `policy.lat` passes `isValidLat` and
   `policy.lon` passes `isValidLon`.

### 9.6 Tests

The package's existing test file. The D36 gate becomes `tests 126, pass 126, fail 0`. Each
negative test is shown red before the gate by a scripted mutation of the check it names.

111. `acceptData` reproduces A1 and returns a fresh 18-byte array.
112. The discriminator equals the first 8 bytes of the package's `sha256` over
     `global:accept`.
113. `ACCEPT_FIELD_RANGE`: `expiresAt` as a number; 2 to the power 63; index -1, 65536 and
     1.5.
114. `ed25519InstructionData` reproduces D1.
115. `ED25519_FIELD_LENGTH` for a 31-byte authority, a 63-byte signature and an empty
     message; `ED25519_FIELD_NOT_BYTES` for a signature given as an array of numbers.
116. `checkVoucher` accepts ELI-01 with the test eligibility public key, `expected` built from
     that vector's fields.
117. `VOUCHER_SHAPE_INVALID`: a 211-byte message; a 63-byte signature; `expiresAt` as a
     number.
118. `VOUCHER_AUTHORITY_MISMATCH`: another 32-byte authority.
119. `VOUCHER_FIELD_MISMATCH`: a different expected `scout`; a different expected `bountyId`;
     `expiresAt` one greater than the message's.
120. `checkAcceptInstructions` accepts the two instructions built from ELI-01 over fixed test
     keys.
121. `TX_INSTRUCTION_COUNT`: one instruction, and three.
122. `TX_PROGRAM`: the first not the ed25519 program; the second another program.
123. `TX_ACCOUNTS`: a key on the ed25519 instruction; keys 1 and 2 swapped; the Scout not a
     signer; the Scout not writable; the bounty not writable; another sysvar in row 3.
124. `TX_DATA`: one byte of the ed25519 data changed; accept data with index 1.
125. `verifyAssignedPolicy` accepts vector V1's policy with its hash, returning V1's `lat` and
     `lon`.
126. `ASSIGNED_HASH_MISMATCH` for a different expected hash; `ASSIGNED_SHAPE_INVALID` for a
     missing `policy` and for a `lat` with six fraction digits under a recomputed hash.

---

## 10. Location helpers

Session 19 (P3). The start gate of `apps/api/POLICY.md` section 17.5 and `apps/mobile/CAPTURE.md`
runs these functions on both sides, so the phone and the server cannot disagree (D133). P4
applies the same gate to each photo's own fix, at the shutter and at submission (D143); P5 may
tighten it for grading, never loosen it.

### 10.1 `distanceM(aLat, aLon, bLat, bLon): number`

The horizontal distance in metres between two points given in decimal degrees, by the
haversine formula on a sphere of radius `R = 6371008.8` metres, computed in exactly this order:

1. `rad = Math.PI / 180`; `p1 = aLat * rad`; `p2 = bLat * rad`; `dp = (bLat - aLat) * rad`;
   `dl = (bLon - aLon) * rad`.
2. `x = sin(dp / 2) ** 2 + cos(p1) * cos(p2) * sin(dl / 2) ** 2`.
3. The result is `2 * R * asin(min(1, sqrt(x)))`.

Latitude and longitude are never compared as planar coordinates. Treating the Earth as a sphere
errs by well under 1 percent at capture-radius scales, far inside any accuracy the phone
reports. A non-finite argument, a latitude outside -90 to 90 or a longitude outside -180 to 180
is `LOCATION_INPUT_INVALID`.

### 10.2 `captureStartDecision(distanceM, accuracyM, radiusM, maxAccuracyM)`

Returns `PASS`, `IMPRECISE` or `TOO_FAR`, in this order:

1. Every argument must be finite, `distanceM` and `accuracyM` 0 or more, `radiusM` and
   `maxAccuracyM` more than 0; otherwise `LOCATION_INPUT_INVALID`.
2. `accuracyM > maxAccuracyM`: `IMPRECISE`. The ceiling is checked first: past it the
   uncertainty circle is too wide for the distance rule to mean anything.
3. `effective = max(0, distanceM - accuracyM)`. `effective <= radiusM`: `PASS`.
4. Otherwise `TOO_FAR`.

Step 3 passes exactly when the circle of radius `accuracyM` around the fix overlaps the capture
circle: presence is possible, not proven.

### 10.3 `checkCaptureStart(fix, target, radiusM, maxAccuracyM)`

`fix` is `{ lat: number; lon: number; accuracyM: number }`, as the phone's location module
reports it. `target` is `{ lat: string; lon: string }`, the policy's strings. Each target string
must pass `isValidLat` or `isValidLon` (section 8.1), else `LOCATION_INPUT_INVALID`; it is then
converted with `Number`. The result is `{ decision, distanceM, effectiveDistanceM }`, where
`distanceM` is section 10.1's from the fix to the target, `decision` is section 10.2's, and
`effectiveDistanceM` is `max(0, distanceM - accuracyM)`.

Section 6 gains one code, `LOCATION_INPUT_INVALID`, owned by all three functions.

### 10.4 Vectors and tests

Distance vectors, target T = (-33.8567844, 151.2152967), within 0.001 m:

| Vector | From | To | `distanceM` |
|---|---|---|---|
| L0 | T | T | 0.000000 |
| L1 | (0, 0) | (0, 1) | 111195.080234 |
| L2 | T | (-33.8558844, 151.2152967) | 100.075572 |
| L3 | T | (-33.8567844, 151.2163967) | 101.574038 |
| L4 | T | (-33.8547844, 151.2152967) | 222.390160 |

The package's existing test file. The D36 gate becomes `tests 130, pass 130, fail 0`. Each
negative test is shown red before the gate by a scripted mutation of the check it names.

127. `distanceM` reproduces L0 to L4 within 0.001 m, and L2 with its points swapped.
128. `captureStartDecision`: (60, 10, 50, 200) `PASS`; (60.001, 10, 50, 200) `TOO_FAR`;
     (5, 30, 10, 200) `PASS`; (0, 200, 10, 200) `PASS`; (0, 200.001, 10, 200) `IMPRECISE`;
     (220, 180, 50, 200) `PASS`.
129. `checkCaptureStart` against T's strings, maximum 200: the fix at T, accuracy 0, radius 10,
     `PASS` with distance 0; L2's point, accuracy 50, radius 50, `TOO_FAR`, effective distance
     50.075572; the same with accuracy 51, `PASS`; L4's point, accuracy 180, radius 50, `PASS`;
     L4's point, accuracy 200.5, radius 5000, `IMPRECISE`.
130. `LOCATION_INPUT_INVALID`: a `NaN` latitude; latitude 90.5; accuracy -1; radius 0; a target
     `lat` of `-33.856784`, six fraction digits.

---

## 11. The evidence manifest

Session 20 (P4). The phone builds the manifest, the API checks it at submission
(`apps/api/POLICY.md` section 18.6), P5's verifier and O3's standalone script recompute its root.
Every rule here is byte-exact, and vectors V6 and V7 (section 11.8) bind all of them (D141).

### 11.1 The manifest

An object with exactly two keys: `header` (section 11.2) and `items`, an array of 1 to 20 item
objects (section 11.3). It travels and is stored as `canonicalise(manifest)`. No two items name
the same requirement id. Items appear in the policy's `evidence_requirements` order and an
optional requirement may have no item; POLICY.md section 18.6 checks both against the policy,
because this section cannot see it.

### 11.2 The header

Exactly these keys:

| Key | Type | Rule |
|---|---|---|
| `assignment_id` | string | uuid, section 8.3's lowercase hyphenated form |
| `bounty_id` | string | uuid, the same form |
| `capture_nonce` | string | 64 lowercase hex characters, exactly as issued (POLICY.md 17.9) |
| `deployment_id` | integer | 0 to 255 |
| `manifest_version` | integer | exactly 1 |
| `policy_hash` | string | 64 lowercase hex characters |
| `scout` | string | 32 to 44 characters of the base58 alphabet; the Scout's wallet |

The API binds `scout` to the caller's wallet by string equality, which also establishes that it
decodes to 32 bytes; this package holds no base58 decoder and does not decode it.

### 11.3 An item

One photo. Exactly these keys:

| Key | Type | Rule |
|---|---|---|
| `byte_length` | integer | 1 or more; the length of the file uploaded |
| `captured_at` | string | a section 11.4 time; the shutter, on the phone's server-time estimate |
| `fixed_at` | string | a section 11.4 time; the location fix's own timestamp |
| `horizontal_accuracy_m` | integer | 0 to 100000; `manifestAccuracy` of the reported accuracy |
| `lat` | string | section 8.1's GPS profile, latitude |
| `lon` | string | section 8.1's GPS profile, longitude |
| `photo_sha256` | string | 64 lowercase hex; section 2's digest of the exact bytes uploaded |
| `requirement_id` | string | uuid, section 8.3's form |

Accuracy is a whole number of metres, rounded up: canonical JSON carries no fractions (section
1.3), and rounding up never understates the uncertainty (D141).

### 11.4 Times

`YYYY-MM-DDTHH:MM:SS.sssZ`: exactly three fraction digits and `Z`, and a real calendar instant,
so that `new Date(text).toISOString()` returns the text unchanged. That is what
`Date.prototype.toISOString` produces for years 1970 to 9999, and SECURITY.md section 14 already
requires UTC with milliseconds.

### 11.5 Leaves and the root

- Leaf 0 is `sha256(utf8(canonicalise(header)))`.
- Leaf `i`, for `i` from 1, is `sha256(utf8(canonicalise(items[i - 1])))`.
- `evidence_root = merkleRoot(leaves)`, section 3.

The header is a leaf so that the root binds the nonce, the assignment, the policy and the
wallet. Each item is its own leaf so that one photo's record can later be shown, with a proof,
without the others. The root is the `evidence_root` of `BOUNTYCAM_ATTESTATION_V1` (MESSAGES.md
section 3).

### 11.6 The signed statement, `BOUNTYCAM_EVIDENCE_V1`

The Scout's wallet signs, with ed25519, the UTF-8 bytes of:

```
canonicalise({
  bounty_id: <the header's bounty_id>,
  domain_tag: "BOUNTYCAM_EVIDENCE_V1",
  evidence_root: <64 lowercase hex>,
  schema_version: 1
})
```

This is SECURITY.md section 5's `BOUNTYCAM_EVIDENCE_V1`: canonical JSON, signed off chain, the
domain tag carried inside as the policy carries its own. It is short and readable, so a wallet
that displays text shows the bounty and the root. It can never verify as a SIWS message, which
begins with a domain line rather than `{`, nor as a binary message, whose tag and length are
fixed (MESSAGES.md section 1).

### 11.7 Functions

- Constants: `EVIDENCE_DOMAIN_TAG` (`BOUNTYCAM_EVIDENCE_V1`), `EVIDENCE_SCHEMA_VERSION` (1),
  `MANIFEST_VERSION` (1), `MAX_EVIDENCE_ITEMS` (20).
- `checkEvidenceManifest(value: unknown): EvidenceManifest` checks sections 11.1 to 11.4 and
  returns the value, typed. A value that is not an object, a key set other than the tables', or
  a value of the wrong JSON type is `MANIFEST_SHAPE`; `items` empty or longer than 20, or a
  repeated `requirement_id`, is `MANIFEST_ITEMS`; any value failing its rule is
  `MANIFEST_FIELD`. Section 6.3's rule on inputs with several faults applies.
- `evidenceLeaves(manifest: unknown): Uint8Array[]` and `evidenceRoot(manifest: unknown):
  Uint8Array` run `checkEvidenceManifest` first, then section 11.5.
- `evidenceStatement(bountyId: string, root: Uint8Array): Uint8Array` returns section 11.6's
  bytes. A `bountyId` not in section 8.3's form, or a `root` that is not a 32-byte
  `Uint8Array`, is `STATEMENT_INPUT_INVALID`.
- `manifestAccuracy(accuracyM: number): number` returns `Math.ceil(accuracyM)`. A non-finite
  value, a negative one, or one above 100000 is `ACCURACY_INVALID`.
- `sha256Chunked(bytes: Uint8Array, chunkBytes: number, pause: () => Promise<void>):
  Promise<Uint8Array>` returns `sha256(bytes)`, fed to the hash in chunks of `chunkBytes` and
  awaiting `pause()` between consecutive chunks, never before the first or after the last.
  `bytes` follows section 2's input rule, with `NOT_BYTES`; `chunkBytes` must be a positive safe
  integer, else `CHUNK_INVALID`. The phone passes 65536 and a zero-delay timer, so the screen
  stays live while a photo hashes (D144).

Section 6.7 lists the codes.

### 11.8 Vectors

Generated by `vectors/gen_evidence_vectors.py`, which implements canonical JSON, the Merkle tree
and base58 itself, in Python, independently of this package (D78). Published as
`vectors/evidence_vectors.json`, immutable under D78; `--check` confirms the file matches a
fresh run. The Scout key derives from the ASCII seed `BOUNTYCAM-TEST-SCOUT-SEED-000001`, a test
value; its base58 is `DsXfdkkMDVSP7XWDZcmN9jMeoXGqyF9BgfmvB4YWdhJs`.

Both vectors share one header: bounty `17e419ff-59a6-4e14-93b4-7a6550d46bd5`, assignment
`96135a13-e126-4213-bc31-58184a6f1e08`, nonce bytes 0 to 31, deployment 2. Its leaf is
`cd4788230fa3c308a9c34e7e2663d4e3977e3fa23a124a77a0867039eeab5d98`.

- **V6**, the header and two items, three leaves, so the odd leaf is promoted. Item leaves
  `1c7e7f7d434221e742f869a90b4edeb7fe01204b5a874882544719b27b7ace09` and
  `94f145de771a8266605bdaaa802aca6970322d489121a33e36faad7753556dc4`. Root
  `2114b0e795a837c9cccc81f8d447b3b98c3913ca942a78e7aefa057f16fc2ebb`.
- **V7**, the header and V6's first item, two leaves. Root
  `64f23b52d49a08310eb010bc59280695198ec4561e211556f93491bf26dc1c9b`.

The JSON file carries, for each vector, the manifest, every canonical text, the leaves, the
root, the statement text and its digest, and the Scout's signature over the statement.

### 11.9 Tests

The package's existing test file. The D36 gate becomes `tests 138, pass 138, fail 0`. Each
negative test is shown red before the gate by a scripted mutation of the check it names.

131. V6 and V7 from the JSON file: `checkEvidenceManifest` accepts each manifest;
     `canonicalise` of it equals `manifest_canonical`; `evidenceLeaves` equals `leaves`;
     `evidenceRoot` equals `evidence_root`.
132. `evidenceStatement` reproduces each vector's `statement_canonical` bytes, and `sha256` of
     them equals `statement_sha256`.
133. `MANIFEST_SHAPE`: a string; a third top-level key; a header without `scout`; an item with a
     ninth key; `deployment_id` as the string `2`; `items` as an object (six asserts).
134. `MANIFEST_ITEMS`: no items; 21 items; two items naming one requirement (three asserts).
135. `MANIFEST_FIELD`: an uppercase hex digit in `capture_nonce`; a 63-character `policy_hash`;
     an uppercase `bounty_id`; `deployment_id` 256; `manifest_version` 2; a `scout` containing
     `0`; `byte_length` 0; `captured_at` without milliseconds; `captured_at`
     `2026-02-30T00:00:00.000Z`; a `lat` with six fraction digits; `horizontal_accuracy_m` -1
     (eleven asserts).
136. `manifestAccuracy`: 0 is 0; 12 is 12; 12.0001 is 13; 199.5 is 200; `ACCURACY_INVALID` for
     -0.1, `NaN`, `Infinity` and 100000.5.
137. `sha256Chunked` with 65536-byte chunks, for inputs of 1, 65536, 65537 and 200001 bytes:
     equal to `sha256`, with `pause` called 0, 0, 1 and 3 times; `CHUNK_INVALID` for 0 and 1.5;
     `NOT_BYTES` for an array of numbers.
138. `STATEMENT_INPUT_INVALID`: an uppercase `bountyId`; a 31-byte root.

---

## 12. The attestation message

Session 21 (P5). The verifier builds `BOUNTYCAM_ATTESTATION_V1` (MESSAGES.md section 3) here,
beside `eligibilityMessage`, so the published vectors bind it (D150). Signing is the caller's.

### 12.1 Constants

`ATTESTATION_DOMAIN_TAG` (`BOUNTYCAM_ATTESTATION_V1`, 24 ASCII bytes),
`ATTESTATION_SCHEMA_VERSION` (1), `ATTESTATION_MESSAGE_LENGTH` (261). `MAX_ASSURANCE_LEVEL` (4)
is shared with section 6.4.

### 12.2 `attestationMessage(fields: AttestationMessageFields): Uint8Array`

The fields, in MESSAGES.md section 3's offset order:

| Field | Type | Rule |
|---|---|---|
| `deploymentId` | number | integer, 0 to 255 |
| `programId` | `Uint8Array` | 32 bytes |
| `bountyId` | `Uint8Array` | 16 bytes |
| `requester` | `Uint8Array` | 32 bytes |
| `scout` | `Uint8Array` | 32 bytes |
| `policyHash` | `Uint8Array` | 32 bytes |
| `eligibilityProfileHash` | `Uint8Array` | 32 bytes |
| `requiredAssurance` | number | integer, 0 to `MAX_ASSURANCE_LEVEL` |
| `deadline` | bigint | within `i64` |
| `reviewWindowSecs` | bigint | within `i64` |
| `evidenceRoot` | `Uint8Array` | 32 bytes |
| `achievedAssurance` | number | integer, 0 to `MAX_ASSURANCE_LEVEL` |
| `issuedAt` | bigint | within `i64` |

It writes the domain tag at 0, the schema version as little-endian `u16` at 24, and each field
at its offset, little-endian throughout, and returns the 261 bytes. Fields are checked in that
order, each fully before the next; the first failure wins. The codes are section 6.4's:
`MESSAGE_FIELD_NOT_BYTES` for a byte field that is not a `Uint8Array`, `MESSAGE_FIELD_LENGTH`
for one at the wrong width, `MESSAGE_FIELD_RANGE` for a number or bigint out of its range or of
the wrong type. Negative `deadline` and `reviewWindowSecs` are accepted, as the vectors require;
the program bounds them, not this function.

### 12.3 Tests

The package's existing test file, beside section 6.4's eligibility tests, reading
`vectors/vectors.json`. The D36 gate becomes `tests 143, pass 143, fail 0`. Each negative test is
shown red before the gate by a scripted mutation of the check it names.

139. Constants: the tag is 24 bytes; length 261; schema version 1; 13 vectors of 261 bytes.
140. Every 261-byte vector is reproduced byte for byte by `attestationMessage` from its parsed
     fields.
141. Every 261-byte vector's signature verifies under the published attester key, and that key
     derives from the published attester seed.
142. Mutations: for each of the 13 mutation vectors on an input field, `attestationMessage` of
     its parsed fields reproduces it; for `domain_tag` and `schema_version`, the rebuilt message
     equals the nominal one, since the function cannot produce either change.
143. Codes: `evidenceRoot` of 31 bytes is `MESSAGE_FIELD_LENGTH`; `scout` as an array of numbers
     is `MESSAGE_FIELD_NOT_BYTES`; `achievedAssurance` 5, `issuedAt` 2 to the 63rd, and
     `deadline` as the number 0 are `MESSAGE_FIELD_RANGE`; `deploymentId` 256 together with
     `achievedAssurance` 5 reports `deploymentId` (six asserts).

---

## 13. Settlement-path helpers

Session 22 (P6), D160. The requester's phone builds `approve` and `reject` (escrow SPEC.md
sections 7.6 and 7.8) and checks them here before MWA sees them (SECURITY.md section 3). The
plain-value instruction form is section 8.7's. The checks reuse section 6.5's four `TX_` codes
with the same meanings.

### 13.1 Constants and data

- `APPROVE_DISCRIMINATOR`, the 8 bytes `454ad9247375614c`; `REJECT_DISCRIMINATOR`, the 8 bytes
  `87073f5583726fe0`: the first eight of `sha256` of `global:approve` and `global:reject`.
- `approveData(): Uint8Array` — the discriminator alone, 8 bytes.
- `rejectData(requirementId: Uint8Array): Uint8Array` — the discriminator, then the 16 bytes,
  24 bytes. Not a `Uint8Array`: `NOT_BYTES`. Not 16 bytes, or all zero:
  `REQUIREMENT_ID_INVALID`. The caller passes `uuidBytes` (section 8.3) of the requirement's id.

### 13.2 `checkApproveInstructions(instructions, expected): void`

`expected` holds `programId`, `requester`, `config`, `bounty`, `usdcMint`, `bountyVault`,
`scout` and `scoutPayout`, 32 bytes each.

1. Exactly two instructions, else `TX_INSTRUCTION_COUNT`.
2. The first's program is `ASSOCIATED_TOKEN_PROGRAM_ID`, the second's `expected.programId`, else
   `TX_PROGRAM`.
3. Exactly these keys, in this order, with these flags, else `TX_ACCOUNTS`:

| Instruction | # | Account | Signer | Writable |
|---|---|---|---|---|
| first | 0 | `requester` | yes | yes |
| | 1 | `scoutPayout` | no | yes |
| | 2 | `scout` | no | no |
| | 3 | `usdcMint` | no | no |
| | 4 | System program | no | no |
| | 5 | Token program | no | no |
| second | 0 | `requester` | yes | yes |
| | 1 | `config` | no | no |
| | 2 | `bounty` | no | yes |
| | 3 | `usdcMint` | no | no |
| | 4 | `bountyVault` | no | yes |
| | 5 | `scout` | no | no |
| | 6 | `scoutPayout` | no | yes |
| | 7 | Token program | no | no |

4. The first's data is the single byte 1 (create idempotent), the second's `approveData()`, else
   `TX_DATA`.

The first instruction is the only non-escrow instruction any BountyCam transaction has carried.
It creates, or leaves unchanged, the Scout's associated token account for the configured mint: it
grants no authority and moves no USDC, so section 3's allowlist names it ("required Associated
Token Program operations").

### 13.3 `checkRejectInstructions(instructions, expected): void`

`expected` holds `programId`, `requester` and `bounty` (32 bytes each) and `requirementId` (16
bytes).

1. Exactly one instruction, else `TX_INSTRUCTION_COUNT`.
2. Its program is `expected.programId`, else `TX_PROGRAM`.
3. Exactly two keys: `requester`, signer and writable; `bounty`, writable, not a signer. Else
   `TX_ACCOUNTS`. The program declares the requester a signer only; the writable flag is the fee
   payer's, as section 9.4 records for the Scout (D128).
4. Its data equals `rejectData(expected.requirementId)`, else `TX_DATA`.

### 13.4 `submittedScout(data: Uint8Array): Uint8Array`

Returns the 32 Scout bytes of a `Submitted` bounty account. `data` is the account's data as read
from the chain. All of: at least 257 bytes; the first eight are the bounty account discriminator;
byte 169 is 2; the tags at bytes 171, 204, 213, 222 and 255 are 1. Otherwise
`ACCOUNT_NOT_SUBMITTED`. The Scout is bytes 172 to 203. The phone also checks that the account's
owner is the escrow program.

### 13.5 Codes

| Code | Function | Rejected input |
|---|---|---|
| `REQUIREMENT_ID_INVALID` | `rejectData` | not 16 bytes, or all zero |
| `ACCOUNT_NOT_SUBMITTED` | `submittedScout` | section 13.4's conditions |

### 13.6 Tests

The package's existing test file. Vectors: an `approve` and a `reject` transaction built with
`@solana/web3.js` 1.98.4 in the architect's sandbox, their instructions in section 8.7's plain
form, under `vectors/settlement.json`; the recorded `Submitted` account of `d649d6f4`. The D36
gate becomes `tests 150, pass 150, fail 0`. Each negative test is shown red before the gate by a
scripted mutation of the check it names.

144. Data: `approveData()` is the 8 discriminator bytes; `rejectData` of the vector's id is 24
     bytes beginning with its discriminator; 15 bytes and 16 zero bytes are
     `REQUIREMENT_ID_INVALID`; an array of numbers is `NOT_BYTES` (four asserts).
145. `checkApproveInstructions` accepts the web3.js vector.
146. Approve mutations: one instruction; three; the first's program the Token program; the second
     key order swapped at 4 and 6; `scoutPayout` not writable; the requester not a signer; a ninth
     key; the first's data 0; the second's data with one bit flipped. Each reports its code (nine
     asserts).
147. `checkRejectInstructions` accepts the web3.js vector.
148. Reject mutations: two instructions; another program; the bounty not writable; a third key;
     another requirement id; the discriminator altered. Each reports its code (six asserts).
149. `submittedScout` of the recorded `d649d6f4` account is the A30's wallet
     `7oSUM9a2PgNbFwYhFFXU5p1mrZr1hTykFWVqosNmT7vW`.
150. `submittedScout` refuses: state byte 1; state byte 4; the tag at 213 set to 0; 256 bytes;
     the discriminator's first byte altered (five asserts).

### 13.7 Amendment A8 (Session 22, build 2)

`expectedApproveKeys(expected)` is exported: it returns section 13.2's table as two lists of
plain account metas, and `checkApproveInstructions` compares against it. The phone builds the
two instructions from the same lists, as it builds funding from `expectedFundingKeys`
(section 8.7), so the table exists once.
