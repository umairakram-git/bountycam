# `@hackathon/shared` — Canonicalisation and Hashing Specification

**Status:** normative. Written before implementation (Session 5).
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
it. Producers are responsible for emitting them in profile form.
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
| cyclic structures | cannot terminate |
| lone surrogates in any string or key | no valid UTF-8 encoding (§1.4) |
| duplicate keys (when input is parsed JSON text) | parser-dependent survivor (§1.2) |
| nesting depth > 64 (note 2 below) | divergent stack-overflow behaviour |

Note 1 — "non-plain objects" are `Date`, `Map`, `Set`, `RegExp`, typed
arrays, and class instances. Each has multiple plausible serialisations;
forcing callers to convert to plain data makes the choice explicit.

Note 2 — depth is counted as the number of nested containers: a top-level
scalar is depth 0, `{"a":[1]}` has depth 2. Depth exactly 64 is accepted.
The limit exists because one implementation must not overflow its stack
where another succeeds — agreement on failure is part of the spec.

### 1.8 Recursion

Arrays and objects recurse with **identical rules at every depth**. There are
no top-level-only or depth-dependent behaviours.
*Why:* any depth-dependent special case doubles the test surface and invites
divergence in exactly the code paths tested least.

---

## 2. `sha256(bytes: Uint8Array): Uint8Array`

SHA-256 as specified in **FIPS 180-4**, no variations. Input is a byte
array; output is the raw 32-byte digest.

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

1. Every input must be exactly 32 bytes; otherwise **reject**.
   *Why:* a wrong-length input is always a caller bug (an unhashed payload or
   a hex string), and concatenating it would silently produce a valid-looking
   root.
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

Input:

```js
{ z: null, "émoji": "🦘", note: "line1\nline2", a: [true, false, {}], _: "" }
```

Canonical string (75 bytes as UTF-8; `é` and `🦘` are literal, `\n` is the
two-character escape; `é` U+00E9 sorts after `z` U+007A):

```
{"_":"","a":[true,false,{}],"note":"line1\nline2","z":null,"émoji":"🦘"}
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
   in every language, forever.
