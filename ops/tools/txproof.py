#!/usr/bin/env python3
"""BountyCam: list the escrow program's devnet transactions, grouped by bounty.

Read-only. Uses only public devnet data (no keys, no wallet, no repo changes). For every
bounty touched since --since it prints each step (create and fund, accept, attestation,
approve / release / reject / resolve / expire), the signature, the time in Sydney, and the
test-USDC movement, and writes the same as Markdown with Solana Explorer links.

Run:  python3 ops/tools/txproof.py [--since 2026-10-05] [--rpc URL] [--out FILE]
Output: demo-transactions.md in the current directory, unless --out names another file.
"""
import json, os, sys, time, urllib.request, urllib.error  # standard library only
from datetime import datetime, timezone, timedelta

PROGRAM = '6c1ouGTmWPhUCnpo5WrcH4R68m3183QpcgKU8TRGEnWS'
MINT = 'ADhRyy71DJJ7QWW3jbBNWPsHZqkWdxRdL9Y75JgYBUcR'
SYD = timezone(timedelta(hours=11))  # AEDT
# Position of the bounty account in each instruction's account list (programs/escrow).
BOUNTY_AT = {'CreateAndFund': 2, 'Cancel': 2, 'Accept': 2, 'SubmitAttestation': 1, 'Reject': 1,
             'ExpireUnaccepted': 2, 'ExpireAccepted': 2, 'Approve': 2, 'Release': 2,
             'Resolve': 3}
LABEL = {'CreateAndFund': 'Create and fund escrow', 'Accept': 'Scout accepts',
         'SubmitAttestation': 'Evidence attested', 'Approve': 'Requester approves, Scout paid',
         'Release': 'Released after review window', 'Reject': 'Requester rejects',
         'Resolve': 'Arbiter resolves', 'Cancel': 'Requester cancels',
         'ExpireUnaccepted': 'Expired, not accepted', 'ExpireAccepted': 'Expired after accept'}


def opt(name, default):
    a = sys.argv[1:]
    return a[a.index(name) + 1] if name in a else default


RPC = opt('--rpc', 'https://api.devnet.solana.com')


def rpc(method, params):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
    for attempt in range(6):
        req = urllib.request.Request(RPC, body, {'content-type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                j = json.load(r)
            if 'error' in j:
                raise RuntimeError(j['error'])
            time.sleep(0.15)
            return j['result']
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 5:
                raise
            time.sleep(2 * (attempt + 1))
    return None


def signatures(since_ts):
    out, before = [], None
    while True:
        p = {'limit': 1000}
        if before:
            p['before'] = before
        page = rpc('getSignaturesForAddress', [PROGRAM, p]) or []
        for s in page:
            if (s.get('blockTime') or 0) < since_ts:
                return out
            out.append(s)
        if len(page) < 1000:
            return out
        before = page[-1]['signature']


def steps(sig, tx):
    """(name, bounty, usdc delta by owner) for each escrow instruction in the transaction."""
    msg, meta = tx['transaction']['message'], tx['meta']
    keys = list(msg['accountKeys'])
    la = meta.get('loadedAddresses') or {}
    keys += la.get('writable', []) + la.get('readonly', [])
    names = [l.split('Instruction: ', 1)[1] for l in meta.get('logMessages') or []
             if l.startswith('Program log: Instruction: ')]
    ours = [ix for ix in msg['instructions'] if keys[ix['programIdIndex']] == PROGRAM]
    delta = {}
    for side, sign in (('preTokenBalances', -1), ('postTokenBalances', 1)):
        for b in meta.get(side) or []:
            if b.get('mint') == MINT:
                delta[b['owner']] = delta.get(b['owner'], 0) + sign * int(b['uiTokenAmount']['amount'])
    delta = {o: d for o, d in delta.items() if d}
    res = []
    for ix, name in zip(ours, [n for n in names if n in BOUNTY_AT or n == 'Initialize']):
        if name in BOUNTY_AT and len(ix['accounts']) > BOUNTY_AT[name]:
            res.append((name, keys[ix['accounts'][BOUNTY_AT[name]]], delta))
    return res


def short(a):
    return a[:4] + '…' + a[-4:]


def usdc(delta):
    return ', '.join('%s %+g' % (short(o), d / 1e6) for o, d in sorted(delta.items(), key=lambda x: x[1]))


def main():
    since = datetime.strptime(opt('--since', '2026-10-05'), '%Y-%m-%d').replace(tzinfo=SYD)
    sigs = [s for s in signatures(int(since.timestamp())) if s.get('err') is None]
    print('%d successful program transactions since %s. Reading them…' % (len(sigs), since.date()))
    bounties = {}
    for i, s in enumerate(sigs, 1):
        tx = rpc('getTransaction', [s['signature'], {'encoding': 'json',
                                                     'maxSupportedTransactionVersion': 0,
                                                     'commitment': 'confirmed'}])
        if not tx:
            continue
        for name, bounty, delta in steps(s['signature'], tx):
            bounties.setdefault(bounty, []).append((tx.get('blockTime') or 0, name, s['signature'], delta))
        if i % 25 == 0:
            print('  %d/%d' % (i, len(sigs)))
    order = sorted(bounties.items(), key=lambda kv: -max(t for t, *_ in kv[1]))
    md = ['# BountyCam devnet transactions', '',
          'Escrow program `%s`, test USDC mint `%s`, Solana devnet.' % (PROGRAM, MINT),
          'Times are Sydney (AEDT). USDC amounts are per token-account owner.', '']
    for n, (bounty, ev) in enumerate(order, 1):
        ev.sort()
        head = 'Bounty %d  account %s  (%d steps, last %s)' % (
            n, bounty, len(ev), datetime.fromtimestamp(ev[-1][0], SYD).strftime('%a %d %b %H:%M'))
        print('\n' + head)
        md += ['## Bounty %d' % n, '',
               'Bounty account: [`%s`](https://explorer.solana.com/address/%s?cluster=devnet)' % (bounty, bounty), '',
               '| Time | Step | Transaction | USDC |', '|---|---|---|---|']
        for t, name, sig, delta in ev:
            when = datetime.fromtimestamp(t, SYD).strftime('%d %b %H:%M:%S')
            print('  %s  %-32s %s  %s' % (when, LABEL.get(name, name), sig, usdc(delta)))
            md.append('| %s | %s | [`%s`](https://explorer.solana.com/tx/%s?cluster=devnet) | %s |'
                      % (when, LABEL.get(name, name), short(sig), sig, usdc(delta)))
        md.append('')
    out = os.path.abspath(os.path.expanduser(opt('--out', 'demo-transactions.md')))
    with open(out, 'w') as f:
        f.write('\n'.join(md))
    print('\n%d bounties. Wrote %s' % (len(order), out))


if __name__ == '__main__':
    main()
