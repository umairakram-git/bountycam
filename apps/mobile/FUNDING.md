# `apps/mobile` — Create and Fund a Bounty

**Status:** normative for Session 17 (P1). Written before implementation.
**Scope:** the requester's path on Android, from an empty form to a funded bounty that
Scouts can discover.
**Style:** per D31 — no line exceeds 100 characters; escape sequences are described in
words, never written literally.

The server side is `apps/api/POLICY.md` section 15. The helpers both sides share are
`packages/shared/SPEC.md` section 8. SECURITY.md wins over this document everywhere, and
those two win over it in their own scope.

---

## 1. Out of scope

Discovery, detail and accept (P2); a map picker and the phone's current location (D122);
any local storage on the phone; fee sponsorship (O1); cancelling a funded bounty on chain.

---

## 2. Screens

Four screens, reached once signed in: Create, Review, Funding and My bounties. Screen
content records Umair's rulings (D122); the steps behind it are technical and normative.

### 2.1 Create

Editable:

| Field | Input | Becomes |
|---|---|---|
| Title | text, 1 to 120 characters | `title` |
| Category | one of Property, Retail, Infrastructure | `category`, the word shown |
| Location | one field: `lat, lon` pasted from a map app | `lat` and `lon` |
| Reward | a USDC amount, up to 6 decimal places | `reward_amount` |
| Photo prompts | 1 to 20 lines, each 1 to 500 characters | `evidence_requirements` |

- Location goes through `parseCoordinatePair` (SPEC.md section 8.1). The parsed pair is
  shown under the field as the requester types, so a wrong paste is visible before
  submit.
- Reward goes through `decimalToBaseUnits(text, 6)` (SPEC.md section 8.6). No double ever
  holds a money value.
- Each prompt becomes a requirement with `type` `PHOTO` and `required` true, in the order
  entered.

Fixed, shown read-only on the form:

| Field | Value | Shown as |
|---|---|---|
| `required_assurance` | 1 | Assurance A1 |
| `eligibility_profile_id` | `BASE_V1` | not shown; A1 implies it (POLICY.md 2.5) |
| `capture_radius_m` | 150 | 150 m |
| `acceptance_window_seconds` | 86400 | open for 24 hours |
| `completion_window_seconds` | 7200 | 2 hours to complete |
| `challenge_window_seconds` | 3600 | 1 hour to review |

A1 because D116 builds the payment path at A1 first; a bounty demanding more cannot be
paid until A2 and A3 land. `cluster` `devnet` and `settlement_mint` are sent explicitly,
so a phone pointed at the wrong environment fails at creation (POLICY.md section 2.1).

Submit sends `POST /bounties`. Each new submission gets a fresh `idempotency_key`, a
version 4 uuid; a retry of the same submission after a network failure reuses it
(POLICY.md section 10), so a retry never creates a second bounty.

### 2.2 Review

When `POST /bounties` returns 201, the phone runs `verifyCreatedBounty` (SPEC.md section
8.5) with `expected` built from exactly what it sent, plus the configured cluster and
mint. Review opens only if that passes; a failure shows "This bounty could not be
verified and was not funded." and offers Cancel.

Review shows values taken from the verified object, never from the form: title,
category, the location pair, the reward in USDC, the number of photos, the fixed values,
the paying wallet (base58, shortened), and the line: "Transfers exactly <amount> USDC
into this bounty's escrow. Grants no spending permission." That line is SECURITY.md
section 3's summary. One button: Fund.

### 2.3 Funding

In order. A failure at steps 1 to 5 stops before the wallet opens, with the message
given.

1. **Wallet.** `getAddress()` must equal the address the session signed in with. Else:
   "Fund from the wallet you signed in with." The bounty's address includes the
   requester's key (POLICY.md section 15.2).
2. **Derive**, with web3.js `PublicKey.findProgramAddressSync`: the config account from
   the seed `config`, which must equal `DqHBCi3KYaZSSgMGcPY8QftYnns8k2vcg9GCJejKBaAb`; the
   bounty from `bounty`, the requester and `uuidBytes(id)`; the vault and the requester's
   token account as associated token accounts, from the seeds owner, Token program and
   mint under the Associated Token program. No new dependency.
3. **Balances**, over the client RPC. The requester's token account must exist and hold
   at least the reward: else "This wallet needs at least <amount> test USDC." The
   requester must hold at least 6000000 lamports, which covers both accounts' rent and
   the fee: else "This wallet needs a little devnet SOL." These are courtesy checks
   (SECURITY.md section 12); the program is the real one.
4. **Build.** One instruction: the escrow program, the nine keys of SPEC.md section 8.7
   in order with their flags, and data `createAndFundData(args)`. One transaction: that
   instruction only, fee payer the requester, recent blockhash from `getLatestBlockhash`
   at `confirmed`. Serialise it unsigned to wire bytes.
5. **Check.** Deserialise the wire bytes with `Transaction.from`, map its instructions to
   plain values, and run `checkFundingInstructions`. Also require the deserialised fee
   payer to be the requester. The check runs on the same bytes the wallet will receive.
   Any failure: "Something went wrong preparing this transaction. Nothing was sent."
6. **Sign and send**: `signAndSendTransaction(wireBytes)` (section 3). From here until
   step 8 ends, Cancel is not offered (POLICY.md section 15.6).
7. **Record** what came back. A signature is shown with a devnet explorer link. A
   failure is kept, but it does not end the flow: a wallet can report failure for a
   transaction that landed (the MWA case D79 cites).
8. **Report.** `POST /bounties/:id/funding` every 2 seconds, at most 45 times — about
   one blockhash lifetime — stopping at the first 200.

| Answer | The phone shows |
|---|---|
| 200 | "Funded — live for Scouts." |
| 409 `NOT_FUNDED` at the last attempt | see below |
| 409 `BINDING_MISMATCH` | "Funded, but it does not match its terms. It will not be listed." |
| 409 `BOUNTY_NOT_FUNDABLE` | "This bounty was cancelled." |
| 503 | nothing new; keep polling within the budget |

`NOT_FUNDED` at the last attempt: if step 6 returned a signature, "Not confirmed yet. It
will show in My bounties once it lands." If step 6 failed, "Funding did not go through."
and Fund is offered again.

Offering Fund again after a failure is safe: a bounty id can be funded once only
(POLICY.md section 15.1), so a second attempt against a first that did land is refused by
the program and moves no money.

### 2.4 My bounties

`GET /me/bounties`, showing each bounty's title, state and reward. On load, the phone
calls `POST /bounties/:id/funding` once for each `DRAFT` row, so a funding whose report
was lost is picked up when its requester looks (POLICY.md section 15.4). A `DRAFT` row
offers Fund and Cancel; Cancel is `POST /bounties/:id/cancel`, never offered while a
funding attempt is running.

Fund from here resumes a bounty created earlier, perhaps before a restart. The phone
keeps no local store, so what it originally sent is gone. It loads `GET /bounties/:id`
and runs `verifyCreatedBounty` with `expected` built from:

- the section 2.1 fixed values, the cluster and the mint — the phone's own constants,
  checked exactly as at creation;
- for title, category, location, reward and prompts, the response's own values.

Review then shows all of them, and the requester confirms them before the wallet opens.
The hash, the constants and the environment are checked in full. The values the phone
cannot remember are checked by the person whose money it is. The flow continues at
section 2.3.

---

## 3. The wallet boundary

`WalletProvider` (`src/wallet/types.ts`) gains one method:

```
signAndSendTransaction(transaction: Uint8Array): Promise<WalletSendResult>
```

- The argument is the unsigned transaction's wire bytes, so the interface stays free of
  chain-library types (SECURITY.md section 14).
- The MWA adapter deserialises it with `Transaction.from`, then inside one `transact`
  authorizes with the stored auth token and calls `signAndSendTransactions` with that one
  transaction: the sequence the MWA spike proved on both devices on 12 September.
- The authorize inside that session must return the stored account. Otherwise the result
  is `ACCOUNT_CHANGED` and nothing is sent.
- Success is `{ ok: true, signature }`, the signature in base58. Failure is a
  `WalletFailure` with a new kind, `ACCOUNT_CHANGED` or `NO_SIGNATURE` (an empty result),
  or the existing `NOT_AUTHORIZED` and `WALLET_ERROR`. A thrown error does not mean
  nothing was sent; section 2.3 step 8 always runs.

---

## 4. Configuration

`src/config.ts` gains compiled constants: the escrow program id, the settlement mint,
the cluster `devnet`, the config account address (checked against its derivation at
section 2.3 step 2), USDC's 6 decimals for display, and the client RPC,
`https://api.devnet.solana.com`, used only for the blockhash and the step 3 balances.

---

## 5. Verification

`apps/mobile` has no test runner. Everything on this path that can be pure lives in
`packages/shared`, with tests (SPEC.md section 8.8); what remains here is assembly. The
device run is the test for it: the first bounty is funded from a phone in Session 17, and
the result is read from the explorer and the database, never from the phone's own screen
(SECURITY.md section 12).
