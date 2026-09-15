#!/usr/bin/env python3
"""
BountyCam binary-message golden vector generator.

Emits the immutable vectors consumed by the escrow program (Rust), the
verifier service (TypeScript) and the Session 17 independent verifier.

Deterministic: same inputs, same bytes, every run. No randomness anywhere.
Signing keys are derived from fixed ASCII seeds so any implementation can
regenerate the same keypairs without shipping key files.

Byte order is little-endian for every multi-byte integer.
No padding. No optional fields. No strings on the signed path except the
fixed-width domain tag.
"""

import json
import struct
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding, PublicFormat, PrivateFormat, NoEncryption,
)

# --------------------------------------------------------------------------
# Field encoders
# --------------------------------------------------------------------------

def u8(v):   return struct.pack("<B", v)
def u16(v):  return struct.pack("<H", v)
def i64(v):  return struct.pack("<q", v)
def raw(b, n):
    assert len(b) == n, f"expected {n} bytes, got {len(b)}"
    return b

# --------------------------------------------------------------------------
# Layout definitions. (name, width, encoder, source)
# source: const | config | state | caller
# --------------------------------------------------------------------------

ATTESTATION_LAYOUT = [
    ("domain_tag",               24, "ascii", "const"),
    ("schema_version",            2, "u16",   "const"),
    ("deployment_id",             1, "u8",    "config"),
    ("program_id",               32, "raw",   "const"),
    ("bounty_id",                16, "raw",   "state"),
    ("requester",                32, "raw",   "state"),
    ("scout",                    32, "raw",   "state"),
    ("policy_hash",              32, "raw",   "state"),
    ("eligibility_profile_hash", 32, "raw",   "state"),
    ("required_assurance",        1, "u8",    "state"),
    ("deadline",                  8, "i64",   "state"),
    ("review_window_secs",        8, "i64",   "state"),
    ("evidence_root",            32, "raw",   "caller"),
    ("achieved_assurance",        1, "u8",    "caller"),
    ("issued_at",                 8, "i64",   "caller"),
]

ELIGIBILITY_LAYOUT = [
    ("domain_tag",               24, "ascii", "const"),
    ("schema_version",            2, "u16",   "const"),
    ("deployment_id",             1, "u8",    "config"),
    ("program_id",               32, "raw",   "const"),
    ("bounty_id",                16, "raw",   "state"),
    ("requester",                32, "raw",   "state"),
    ("scout",                    32, "raw",   "state"),
    ("policy_hash",              32, "raw",   "state"),
    ("eligibility_profile_hash", 32, "raw",   "state"),
    ("required_assurance",        1, "u8",    "state"),
    ("expires_at",                8, "i64",   "caller"),
]

ENCODERS = {"u8": u8, "u16": u16, "i64": i64}


def offsets(layout):
    out, off = [], 0
    for name, width, enc, src in layout:
        out.append({"offset": off, "width": width, "field": name,
                    "encoding": enc, "source": src})
        off += width
    return out, off


def build(layout, values):
    buf = b""
    for name, width, enc, _src in layout:
        v = values[name]
        if enc == "raw":
            buf += raw(v, width)
        elif enc == "ascii":
            b = v.encode("ascii")
            buf += raw(b, width)
        else:
            buf += ENCODERS[enc](v)
    return buf

# --------------------------------------------------------------------------
# Deterministic test keys
# --------------------------------------------------------------------------

ATTESTER_SEED    = b"BOUNTYCAM-TEST-ATTESTER-SEED-001"
ELIGIBILITY_SEED = b"BOUNTYCAM-TEST-ELIGIBILITY-SEED1"


def keypair(seed):
    assert len(seed) == 32
    sk = Ed25519PrivateKey.from_private_bytes(seed)
    pk = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return sk, pk

# --------------------------------------------------------------------------
# Fixed test inputs. Recognisable fill patterns, never real keys.
# --------------------------------------------------------------------------

PROGRAM_ID   = bytes.fromhex("11" * 32)
BOUNTY_ID    = bytes.fromhex("22" * 16)
REQUESTER    = bytes.fromhex("33" * 32)
SCOUT        = bytes.fromhex("44" * 32)
POLICY_HASH  = bytes.fromhex("55" * 32)
PROFILE_HASH = bytes.fromhex("66" * 32)
EVIDENCE_ROOT= bytes.fromhex("77" * 32)

BASE_ATTESTATION = {
    "domain_tag": "BOUNTYCAM_ATTESTATION_V1",
    "schema_version": 1,
    "deployment_id": 1,
    "program_id": PROGRAM_ID,
    "bounty_id": BOUNTY_ID,
    "requester": REQUESTER,
    "scout": SCOUT,
    "policy_hash": POLICY_HASH,
    "eligibility_profile_hash": PROFILE_HASH,
    "required_assurance": 2,
    "deadline": 1_790_000_000,
    "review_window_secs": 86_400,
    "evidence_root": EVIDENCE_ROOT,
    "achieved_assurance": 3,
    "issued_at": 1_789_900_000,
}

BASE_ELIGIBILITY = {
    "domain_tag": "BOUNTYCAM_ELIGIBILITY_V1",
    "schema_version": 1,
    "deployment_id": 1,
    "program_id": PROGRAM_ID,
    "bounty_id": BOUNTY_ID,
    "requester": REQUESTER,
    "scout": SCOUT,
    "policy_hash": POLICY_HASH,
    "eligibility_profile_hash": PROFILE_HASH,
    "required_assurance": 4,
    "expires_at": 1_789_903_600,
}

I64_MAX = 2**63 - 1
I64_MIN = -(2**63)


def vector(name, note, layout, values, sk):
    msg = build(layout, values)
    sig = sk.sign(msg)
    return {
        "name": name,
        "note": note,
        "message_len": len(msg),
        "message_hex": msg.hex(),
        "signature_hex": sig.hex(),
    }


def main():
    atk, apk = keypair(ATTESTER_SEED)
    elk, elpk = keypair(ELIGIBILITY_SEED)

    att_fields, att_len = offsets(ATTESTATION_LAYOUT)
    eli_fields, eli_len = offsets(ELIGIBILITY_LAYOUT)

    def att(**over):
        v = dict(BASE_ATTESTATION); v.update(over); return v

    def eli(**over):
        v = dict(BASE_ELIGIBILITY); v.update(over); return v

    vectors = []

    # --- attestation: nominal and boundaries -----------------------------
    vectors.append(vector("ATT-01", "nominal attestation",
                          ATTESTATION_LAYOUT, att(), atk))
    vectors.append(vector("ATT-02", "deadline at i64 max",
                          ATTESTATION_LAYOUT, att(deadline=I64_MAX), atk))
    vectors.append(vector("ATT-03", "deadline at i64 min (negative timestamp)",
                          ATTESTATION_LAYOUT, att(deadline=I64_MIN), atk))
    vectors.append(vector("ATT-04", "review_window_secs zero",
                          ATTESTATION_LAYOUT, att(review_window_secs=0), atk))
    vectors.append(vector("ATT-05", "review_window_secs negative (currently storable on-chain)",
                          ATTESTATION_LAYOUT, att(review_window_secs=-1), atk))
    vectors.append(vector("ATT-06", "assurance floor: required 0, achieved 0",
                          ATTESTATION_LAYOUT,
                          att(required_assurance=0, achieved_assurance=0), atk))
    vectors.append(vector("ATT-07", "assurance ceiling MAX_ASSURANCE_LEVEL=4",
                          ATTESTATION_LAYOUT,
                          att(required_assurance=4, achieved_assurance=4), atk))
    vectors.append(vector("ATT-08", "achieved exceeds required (valid per D17)",
                          ATTESTATION_LAYOUT,
                          att(required_assurance=2, achieved_assurance=4), atk))
    vectors.append(vector("ATT-09", "deployment_id 0",
                          ATTESTATION_LAYOUT, att(deployment_id=0), atk))
    vectors.append(vector("ATT-10", "deployment_id 255 (u8 ceiling)",
                          ATTESTATION_LAYOUT, att(deployment_id=255), atk))
    vectors.append(vector("ATT-11", "issued_at zero (unix epoch)",
                          ATTESTATION_LAYOUT, att(issued_at=0), atk))
    vectors.append(vector("ATT-12", "all-zero hashes and ids",
                          ATTESTATION_LAYOUT,
                          att(bounty_id=bytes(16), requester=bytes(32),
                              scout=bytes(32), policy_hash=bytes(32),
                              eligibility_profile_hash=bytes(32),
                              evidence_root=bytes(32)), atk))
    vectors.append(vector("ATT-13", "all-ones hashes and ids",
                          ATTESTATION_LAYOUT,
                          att(bounty_id=b"\xff"*16, requester=b"\xff"*32,
                              scout=b"\xff"*32, policy_hash=b"\xff"*32,
                              eligibility_profile_hash=b"\xff"*32,
                              evidence_root=b"\xff"*32), atk))

    # --- eligibility: nominal and boundaries ------------------------------
    vectors.append(vector("ELI-01", "nominal eligibility voucher",
                          ELIGIBILITY_LAYOUT, eli(), elk))
    vectors.append(vector("ELI-02", "expires_at at i64 max",
                          ELIGIBILITY_LAYOUT, eli(expires_at=I64_MAX), elk))
    vectors.append(vector("ELI-03", "expires_at zero",
                          ELIGIBILITY_LAYOUT, eli(expires_at=0), elk))
    vectors.append(vector("ELI-04", "required_assurance 0",
                          ELIGIBILITY_LAYOUT, eli(required_assurance=0), elk))

    # --- mutation set: one per signed field, attestation -------------------
    mutations = []
    for f in att_fields:
        name, width = f["field"], f["width"]
        base = att()
        if name == "domain_tag":
            mutated = "BOUNTYCAM_ATTESTATION_V2"
        elif name == "schema_version":
            mutated = 2
        elif width in (1,):
            mutated = (base[name] + 1) % 256
        elif width == 8:
            mutated = base[name] + 1
        else:
            b = bytearray(base[name]); b[0] ^= 0x01; mutated = bytes(b)
        v = att(**{name: mutated})
        msg = build(ATTESTATION_LAYOUT, v)
        mutations.append({
            "field": name,
            "offset": f["offset"],
            "width": width,
            "message_hex": msg.hex(),
            "expect": "program rejects: reconstructed bytes differ",
        })

    # --- cross-type rejection ----------------------------------------------
    eli_msg = build(ELIGIBILITY_LAYOUT, eli())
    att_msg = build(ATTESTATION_LAYOUT, att())
    cross = {
        "eligibility_presented_to_attestation_path": {
            "message_hex": eli_msg.hex(),
            "message_len": len(eli_msg),
            "expect": "reject: wrong length and wrong domain tag",
        },
        "attestation_presented_to_eligibility_path": {
            "message_hex": att_msg.hex(),
            "message_len": len(att_msg),
            "expect": "reject: wrong length and wrong domain tag",
        },
        "attestation_signed_by_eligibility_authority": {
            "message_hex": att_msg.hex(),
            "signature_hex": elk.sign(att_msg).hex(),
            "expect": "reject: signature verifies but authority is not the attester",
        },
    }

    doc = {
        "spec": "packages/shared/MESSAGES.md",
        "generator": "gen_vectors.py",
        "byte_order": "little-endian",
        "authorities": {
            "attester_seed_ascii": ATTESTER_SEED.decode(),
            "attester_pubkey_hex": apk.hex(),
            "eligibility_seed_ascii": ELIGIBILITY_SEED.decode(),
            "eligibility_pubkey_hex": elpk.hex(),
        },
        "layouts": {
            "BOUNTYCAM_ATTESTATION_V1": {
                "total_bytes": att_len, "fields": att_fields},
            "BOUNTYCAM_ELIGIBILITY_V1": {
                "total_bytes": eli_len, "fields": eli_fields},
        },
        "vectors": vectors,
        "mutations_attestation": mutations,
        "cross_type_rejection": cross,
    }

    import os
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with open("vectors.json", "w") as fh:
        json.dump(doc, fh, indent=2)

    # --- console summary ----------------------------------------------------
    print(f"ATTESTATION total: {att_len} bytes")
    print(f"ELIGIBILITY total: {eli_len} bytes")
    print(f"attester pubkey    : {apk.hex()}")
    print(f"eligibility pubkey : {elpk.hex()}")
    print()
    print("offset width field                      enc    source")
    for f in att_fields:
        print(f"{f['offset']:>6} {f['width']:>5} {f['field']:<26} "
              f"{f['encoding']:<6} {f['source']}")
    print()
    print(f"vectors: {len(vectors)}  mutations: {len(mutations)}  "
          f"cross-type: {len(cross)}")
    print()
    print("ATT-01 message hex:")
    print(vectors[0]["message_hex"])
    print("ATT-01 signature hex:")
    print(vectors[0]["signature_hex"])

    # --- self-check ---------------------------------------------------------
    assert att_len == sum(w for _, w, _, _ in ATTESTATION_LAYOUT)
    assert eli_len == sum(w for _, w, _, _ in ELIGIBILITY_LAYOUT)
    assert len(set(v["message_hex"] for v in vectors)) == len(vectors), \
        "two vectors produced identical bytes"
    assert len(set(m["message_hex"] for m in mutations)) == len(mutations), \
        "two mutations produced identical bytes"
    base_hex = build(ATTESTATION_LAYOUT, att()).hex()
    assert all(m["message_hex"] != base_hex for m in mutations), \
        "a mutation did not change the bytes"
    print("\nself-checks passed")


if __name__ == "__main__":
    main()
