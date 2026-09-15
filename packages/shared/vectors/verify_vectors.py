#!/usr/bin/env python3
"""Independent check: decode vectors.json by offset table, verify signatures."""
import json, struct
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.exceptions import InvalidSignature

import os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
d = json.load(open("vectors.json"))
att_pk = Ed25519PublicKey.from_public_bytes(
    bytes.fromhex(d["authorities"]["attester_pubkey_hex"]))
eli_pk = Ed25519PublicKey.from_public_bytes(
    bytes.fromhex(d["authorities"]["eligibility_pubkey_hex"]))

def fields(tag): return d["layouts"][tag]["fields"]
def total(tag):  return d["layouts"][tag]["total_bytes"]

ok = fail = 0
for v in d["vectors"]:
    msg = bytes.fromhex(v["message_hex"])
    tag = msg[:24].decode("ascii")
    pk = att_pk if tag.startswith("BOUNTYCAM_ATTESTATION") else eli_pk
    want = total(tag) if tag in d["layouts"] else None
    assert want is None or len(msg) == want, f"{v['name']} length {len(msg)} != {want}"
    assert len(msg) == v["message_len"]
    try:
        pk.verify(bytes.fromhex(v["signature_hex"]), msg)
        ok += 1
    except InvalidSignature:
        print(f"SIGNATURE FAIL {v['name']}"); fail += 1

# decode ATT-01 by the published offset table only
a = next(v for v in d["vectors"] if v["name"] == "ATT-01")
msg = bytes.fromhex(a["message_hex"])
print("\nATT-01 decoded by offset table:")
for f in fields("BOUNTYCAM_ATTESTATION_V1"):
    s = msg[f["offset"]:f["offset"]+f["width"]]
    if f["encoding"] == "ascii": val = s.decode()
    elif f["encoding"] == "u8":  val = struct.unpack("<B", s)[0]
    elif f["encoding"] == "u16": val = struct.unpack("<H", s)[0]
    elif f["encoding"] == "i64": val = struct.unpack("<q", s)[0]
    else: val = s.hex()[:16] + ("..." if f["width"] > 8 else "")
    print(f"  {f['offset']:>3} {f['field']:<26} {val}")

# cross-type: wrong-authority vector must fail against the attester key
c = d["cross_type_rejection"]["attestation_signed_by_eligibility_authority"]
try:
    att_pk.verify(bytes.fromhex(c["signature_hex"]), bytes.fromhex(c["message_hex"]))
    print("\nCROSS-TYPE CHECK FAILED: wrong authority verified"); fail += 1
except InvalidSignature:
    print("\ncross-type: wrong-authority signature correctly rejected")

# mutations must all differ from ATT-01
base = a["message_hex"]
assert all(m["message_hex"] != base for m in d["mutations_attestation"])
print(f"mutations: {len(d['mutations_attestation'])} all differ from nominal")
print(f"\nsignatures verified: {ok}   failures: {fail}")
