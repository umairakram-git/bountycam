#!/usr/bin/env python3
"""Fund requester wallets on devnet with test USDC and SOL (D122 ruling 1).

Usage:
  python3 devnet_fund_requester.py <wallet> [<wallet> ...] [--amount 1000]

Per wallet: report SOL and airdrop 1 SOL if below 0.05; derive the associated token
account for the BountyCam devnet mint, create it if absent (upgrade authority pays);
mint --amount test USDC into it, signed by the upgrade authority (the mint authority,
D102); print the balances after. Every command is printed with its raw output.

Kept at scripts/devnet_fund_requester.py in the repo; the first run copies it there.
"""
import argparse
import hashlib
import os
import shutil
import subprocess
import sys

REPO = "/Users/umairakram/Developer/hackathon202609"
REPO_COPY = os.path.join(REPO, "scripts", "devnet_fund_requester.py")
KEY = os.path.expanduser("~/bountycam-keys/upgrade-authority.json")
URL = "devnet"
MINT = "ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR"
TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
SOL_FLOOR = 0.05
AIRDROP_SOL = "1"
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def die(msg):
    print("ABORT: " + msg)
    sys.exit(1)


def b58decode(s):
    n = 0
    for c in s:
        if c not in B58:
            die("not base58: " + s)
        n = n * 58 + B58.index(c)
    body = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + body


def b58encode(b):
    n = int.from_bytes(b, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(b) - len(b.lstrip(b"\0"))) + s


def on_curve(b):
    p = 2**255 - 19
    d = (-121665 * pow(121666, p - 2, p)) % p
    y = (int.from_bytes(b, "little") & ((1 << 255) - 1)) % p
    u = (y * y - 1) % p
    v = (d * y * y + 1) % p
    x2 = u * pow(v, p - 2, p) % p
    return x2 == 0 or pow(x2, (p - 1) // 2, p) == 1


def pda(seeds, program):
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program
                           + b"ProgramDerivedAddress").digest()
        if not on_curve(h):
            return b58encode(h)
    die("no PDA")


def ata(owner):
    return pda([b58decode(owner), b58decode(TOKEN_PROGRAM), b58decode(MINT)],
               b58decode(ATA_PROGRAM))


def run(cmd, fatal=True):
    print("$ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = (r.stdout + r.stderr).rstrip()
    print(out if out else "(no output)")
    if r.returncode != 0 and fatal:
        die("command failed with exit " + str(r.returncode))
    return r.returncode, out


def sol_balance(wallet):
    _, out = run(["solana", "balance", wallet, "--url", URL])
    try:
        return float(out.split()[0])
    except (ValueError, IndexError):
        die("could not read the SOL balance from: " + out)


def keep_repo_copy():
    me = os.path.abspath(__file__)
    if me == os.path.abspath(REPO_COPY):
        return
    with open(me, "rb") as f:
        mine = hashlib.sha256(f.read()).hexdigest()
    if os.path.exists(REPO_COPY):
        with open(REPO_COPY, "rb") as f:
            theirs = hashlib.sha256(f.read()).hexdigest()
        if theirs != mine:
            die("scripts/devnet_fund_requester.py in the repo differs from this file")
        return
    os.makedirs(os.path.dirname(REPO_COPY), exist_ok=True)
    shutil.copyfile(me, REPO_COPY)
    print(f"copied to {REPO_COPY}  {mine[:8]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wallets", nargs="+")
    ap.add_argument("--amount", default="1000", help="test USDC per wallet (default 1000)")
    args = ap.parse_args()
    if not os.path.isfile(KEY):
        die("upgrade authority key not found at " + KEY)
    for w in args.wallets:
        if len(b58decode(w)) != 32:
            die("not a 32-byte key: " + w)
    keep_repo_copy()

    for wallet in args.wallets:
        print("\n== " + wallet + " ==")
        account = ata(wallet)
        print("associated token account: " + account)

        if sol_balance(wallet) < SOL_FLOOR:
            code, _ = run(["solana", "airdrop", AIRDROP_SOL, wallet, "--url", URL], fatal=False)
            if code != 0:
                print("airdrop refused; use https://faucet.solana.com for " + wallet)

        code, _ = run(["solana", "account", account, "--url", URL], fatal=False)
        if code != 0:
            run(["spl-token", "create-account", MINT, "--owner", wallet,
                 "--fee-payer", KEY, "--url", URL])

        run(["spl-token", "mint", MINT, args.amount, account,
             "--mint-authority", KEY, "--fee-payer", KEY, "--url", URL])

        run(["spl-token", "balance", "--address", account, "--url", URL])
        sol_balance(wallet)
        print("explorer: https://explorer.solana.com/address/" + account + "?cluster=devnet")


if __name__ == "__main__":
    main()
