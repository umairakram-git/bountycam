#!/usr/bin/env python3
"""
BountyCam evidence manifest golden vectors (packages/shared/SPEC.md section 11).

Independent of the TypeScript package: canonical JSON, the Merkle tree and base58
are implemented here from SPEC.md sections 1 to 3 and 11, so a disagreement with
packages/shared shows up as a failed vector rather than a shared bug (D78).

Deterministic: no randomness. The Scout key comes from a fixed ASCII seed, a test
value that must never sign anything on a live deployment.

    python3 gen_evidence_vectors.py            writes evidence_vectors.json
    python3 gen_evidence_vectors.py --check    exits 1 if the file differs
"""
import hashlib, json, sys
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

SCOUT_SEED = b"BOUNTYCAM-TEST-SCOUT-SEED-000001"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58(data: bytes) -> str:
    n = int.from_bytes(data, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = B58[r] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def canonical(value) -> str:
    # SPEC.md section 1, for the value domain these vectors use: plain objects,
    # arrays, ASCII-keyed, strings without control characters, safe integers.
    if isinstance(value, bool) or value is None:
        return json.dumps(value)
    if isinstance(value, int):
        assert abs(value) <= 2**53 - 1
        return str(value)
    if isinstance(value, str):
        assert all(0x20 <= ord(c) < 0x7F for c in value)
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value)  # ASCII keys: code-unit order equals byte order
        return "{" + ",".join(json.dumps(k) + ":" + canonical(value[k]) for k in keys) + "}"
    raise TypeError(type(value))


def sha(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def merkle_root(leaves):
    assert leaves and all(len(x) == 32 for x in leaves)
    level = [sha(b"\x00" + h) for h in leaves]
    while len(level) > 1:
        nxt = [sha(b"\x01" + level[i] + level[i + 1]) for i in range(0, len(level) - 1, 2)]
        if len(level) % 2:
            nxt.append(level[-1])
        level = nxt
    return level[0]


def scout_key():
    sk = Ed25519PrivateKey.from_private_bytes(SCOUT_SEED)
    pk = sk.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return sk, pk


def build(name, items):
    sk, pk = scout_key()
    header = {
        "assignment_id": "96135a13-e126-4213-bc31-58184a6f1e08",
        "bounty_id": "17e419ff-59a6-4e14-93b4-7a6550d46bd5",
        "capture_nonce": bytes(range(32)).hex(),
        "deployment_id": 2,
        "manifest_version": 1,
        "policy_hash": sha(b"V6 policy").hex(),
        "scout": b58(pk),
    }
    header_text = canonical(header)
    item_texts = [canonical(i) for i in items]
    leaves = [sha(header_text.encode())] + [sha(t.encode()) for t in item_texts]
    root = merkle_root(leaves)
    statement = {
        "bounty_id": header["bounty_id"],
        "domain_tag": "BOUNTYCAM_EVIDENCE_V1",
        "evidence_root": root.hex(),
        "schema_version": 1,
    }
    statement_text = canonical(statement)
    signature = sk.sign(statement_text.encode())
    manifest = {"header": header, "items": items}
    return {
        "name": name,
        "manifest": manifest,
        "manifest_canonical": canonical(manifest),
        "header_canonical": header_text,
        "item_canonical": item_texts,
        "leaves": [x.hex() for x in leaves],
        "evidence_root": root.hex(),
        "statement_canonical": statement_text,
        "statement_sha256": sha(statement_text.encode()).hex(),
        "signature": signature.hex(),
    }


ITEM_1 = {
    "byte_length": 1425407,
    "captured_at": "2026-10-01T00:05:12.345Z",
    "fixed_at": "2026-10-01T00:05:11.900Z",
    "horizontal_accuracy_m": 12,
    "lat": "-33.8568000",
    "lon": "151.2153000",
    "photo_sha256": sha(b"photo-1").hex(),
    "requirement_id": "11111111-1111-4111-8111-111111111111",
}
ITEM_2 = {
    "byte_length": 983211,
    "captured_at": "2026-10-01T00:06:40.000Z",
    "fixed_at": "2026-10-01T00:06:38.120Z",
    "horizontal_accuracy_m": 35,
    "lat": "-33.8569123",
    "lon": "151.2150456",
    "photo_sha256": sha(b"photo-2").hex(),
    "requirement_id": "22222222-2222-4222-8222-222222222222",
}


def main():
    sk, pk = scout_key()
    doc = {
        "spec": "packages/shared/SPEC.md section 11",
        "scout_seed_ascii": SCOUT_SEED.decode(),
        "scout_public_key_hex": pk.hex(),
        "scout_base58": b58(pk),
        "vectors": [build("V6", [ITEM_1, ITEM_2]), build("V7", [ITEM_1])],
    }
    text = json.dumps(doc, indent=2, ensure_ascii=True) + "\n"
    target = Path(__file__).with_name("evidence_vectors.json")
    if "--check" in sys.argv:
        same = target.exists() and target.read_text() == text
        print("evidence vectors " + ("match" if same else "DIFFER"))
        sys.exit(0 if same else 1)
    target.write_text(text)
    print("wrote " + str(target))


if __name__ == "__main__":
    assert len(SCOUT_SEED) == 32
    main()
