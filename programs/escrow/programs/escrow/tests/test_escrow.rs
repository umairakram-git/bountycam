use {
    anchor_lang::{
        // base64 through anchor-lang's private re-export: acceptable because
        // anchor-lang is pinned =1.1.2, so the re-export cannot drift.
        __private::base64::{engine::general_purpose::STANDARD, Engine},
        prelude::{Clock, ProgramData, Pubkey},
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            program_pack::Pack,
            system_instruction, system_program,
        },
        AccountDeserialize, AccountSerialize, AnchorDeserialize, Discriminator,
        InstructionData, Space, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{self, spl_associated_token_account},
        token::spl_token,
        token_2022::spl_token_2022,
    },
    escrow::{
        constants::{BOUNTY_SEED, CONFIG_SEED},
        events::BountyCancelled,
        state::{Bounty, BountyState, Config},
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_ed25519_program::new_ed25519_instruction_with_signature,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const NOW: i64 = 1_760_000_000;
const DECIMALS: u8 = 6;
const INITIAL_BALANCE: u64 = 1_000_000_000; // 1,000 USDC
const REWARD: u64 = 100_000_000; // 100 USDC
const POLICY_HASH: [u8; 32] = [7u8; 32];
const PROFILE_HASH: [u8; 32] = [9u8; 32];
const ACCEPTANCE_WINDOW: i64 = 86_400;
const COMPLETION_WINDOW: i64 = 172_800;
const REVIEW_WINDOW: i64 = 3_600;
const DEPLOYMENT_ID: u8 = 1;
const PROGRAM_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/escrow.so"));
/// The test-only CPI caller (SPEC section 12 harness rules, D90), built by
/// `cargo build-sbf` in the counted run. A missing file fails compilation.
const CPI_CALLER_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/cpi_caller.so"));
/// The caller's ID (D90): 32 bytes of 0xC7, not a point on the ed25519 curve.
const CPI_CALLER_ID: Pubkey =
    Pubkey::from_str_const("ESrpUvg2gM75m1mzoSuquCaoabs42edBCCdabdvDgJBg");
/// Anchor discriminator of the caller's `forward`: the first eight bytes of
/// sha256 of `global:forward`, verified independently (D90).
const FORWARD_DISCRIMINATOR: [u8; 8] = [0x2d, 0xa5, 0xc9, 0x74, 0xce, 0xe1, 0xf1, 0x12];
/// The published vectors (D78): the layout tables place every field of the
/// test-side message builders, independently of the program's builders.
const VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/shared/vectors/vectors.json"
));
/// Default voucher lifetime in the accept tests; well inside the cutoff.
const VOUCHER_TTL: i64 = 600;

struct Setup {
    svm: LiteSVM,
    /// Harness upgrade authority, written into ProgramData by `set_upgrade_authority`.
    upgrade_authority: Keypair,
    requester: Keypair,
    usdc_mint: Pubkey,
    requester_ata: Pubkey,
    config: Pubkey,
    /// The three configured authorities, generated per run (SECURITY.md
    /// section 7). Only their public keys reach `initialize`; the secret
    /// halves sign vouchers and attestations from the `accept` tests onward.
    eligibility: Keypair,
    attester: Keypair,
    arbiter: Keypair,
}

fn program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

fn config_pda() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &escrow::id()).0
}

/// Harness setup (D83). litesvm 0.10.0 `add_program` records the upgrade
/// authority as `None`. The ProgramData metadata is bincode: a 4-byte variant
/// tag, an 8-byte slot, a 1-byte `Option` tag at offset 12 and the 32-byte key
/// at 13 to 44. This patches those bytes and reads them back through Anchor's
/// own `ProgramData` deserialiser to confirm the layout assumption.
fn set_upgrade_authority(svm: &mut LiteSVM, program_id: &Pubkey, authority: &Pubkey) {
    let address = program_data_address(program_id);
    let mut account = svm.get_account(&address).unwrap();
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(address, account).unwrap();

    let account = svm.get_account(&address).unwrap();
    let state = ProgramData::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(state.upgrade_authority_address, Some(*authority));
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ixs: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx)
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair) -> Pubkey {
    let mint = Keypair::new();
    let rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    let ixs = [
        system_instruction::create_account(
            &payer.pubkey(),
            &mint.pubkey(),
            rent,
            spl_token::state::Mint::LEN as u64,
            &spl_token::id(),
        ),
        spl_token::instruction::initialize_mint2(
            &spl_token::id(),
            &mint.pubkey(),
            &payer.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(svm, payer, &ixs, &[payer, &mint]).unwrap();
    mint.pubkey()
}

fn create_funded_ata(
    svm: &mut LiteSVM,
    payer: &Keypair,
    owner: &Pubkey,
    mint: &Pubkey,
    amount: u64,
) -> Pubkey {
    let ata = associated_token::get_associated_token_address(owner, mint);
    let mut ixs = vec![
        spl_associated_token_account::instruction::create_associated_token_account(
            &payer.pubkey(),
            owner,
            mint,
            &spl_token::id(),
        ),
    ];
    if amount > 0 {
        ixs.push(
            spl_token::instruction::mint_to(
                &spl_token::id(),
                mint,
                &ata,
                &payer.pubkey(),
                &[],
                amount,
            )
            .unwrap(),
        );
    }
    send(svm, payer, &ixs, &[payer]).unwrap();
    ata
}

/// Program loaded, clock set, requester funded, mint and token account created.
/// ProgramData is the harness default (upgrade authority `None`) and no
/// configuration exists.
fn setup_bare() -> Setup {
    let mut svm = LiteSVM::new();
    svm.add_program(escrow::id(), PROGRAM_BYTES).unwrap();

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = NOW;
    svm.set_sysvar::<Clock>(&clock);

    let upgrade_authority = Keypair::new();
    svm.airdrop(&upgrade_authority.pubkey(), 10_000_000_000).unwrap();
    let requester = Keypair::new();
    svm.airdrop(&requester.pubkey(), 10_000_000_000).unwrap();

    let usdc_mint = create_mint(&mut svm, &requester);
    let requester_ata =
        create_funded_ata(&mut svm, &requester, &requester.pubkey(), &usdc_mint, INITIAL_BALANCE);

    Setup {
        svm,
        upgrade_authority,
        requester,
        usdc_mint,
        requester_ata,
        config: config_pda(),
        eligibility: Keypair::new(),
        attester: Keypair::new(),
        arbiter: Keypair::new(),
    }
}

/// `setup_bare` plus the ProgramData overwrite. No configuration yet.
fn setup_uninitialized() -> Setup {
    let mut s = setup_bare();
    let authority = s.upgrade_authority.pubkey();
    set_upgrade_authority(&mut s.svm, &escrow::id(), &authority);
    s
}

/// `setup_uninitialized` plus a successful `initialize`.
fn setup() -> Setup {
    let mut s = setup_uninitialized();
    let ix = initialize_ix(&s, s.upgrade_authority.pubkey(), s.usdc_mint);
    send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]).unwrap();
    s
}

/// `initialize` with the setup's three authorities and the escrow's own
/// ProgramData. Tests substitute one account or argument at a time.
fn initialize_ix(s: &Setup, authority: Pubkey, usdc_mint: Pubkey) -> Instruction {
    initialize_ix_full(
        authority,
        usdc_mint,
        program_data_address(&escrow::id()),
        [s.eligibility.pubkey(), s.attester.pubkey(), s.arbiter.pubkey()],
    )
}

fn initialize_ix_full(
    authority: Pubkey,
    usdc_mint: Pubkey,
    program_data: Pubkey,
    keys: [Pubkey; 3],
) -> Instruction {
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::Initialize {
            deployment_id: DEPLOYMENT_ID,
            eligibility_authority: keys[0],
            attester_authority: keys[1],
            arbiter_authority: keys[2],
        }
        .data(),
        escrow::accounts::Initialize {
            authority,
            config: config_pda(),
            usdc_mint,
            program_data,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn read_config(svm: &LiteSVM, config: &Pubkey) -> Config {
    let account = svm.get_account(config).unwrap();
    Config::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn bounty_pda(requester: &Pubkey, bounty_id: &[u8; 16]) -> Pubkey {
    Pubkey::find_program_address(
        &[BOUNTY_SEED, requester.as_ref(), bounty_id.as_ref()],
        &escrow::id(),
    )
    .0
}

/// The token-side accounts of `create_and_fund` and `cancel`. Tests that
/// substitute one account build the default and replace one field.
struct TokenAccounts {
    config: Pubkey,
    usdc_mint: Pubkey,
    bounty_vault: Pubkey,
    requester_ata: Pubkey,
    token_program: Pubkey,
}

fn token_accounts(s: &Setup, bounty: &Pubkey, requester_ata: Pubkey) -> TokenAccounts {
    TokenAccounts {
        config: s.config,
        usdc_mint: s.usdc_mint,
        bounty_vault: associated_token::get_associated_token_address(bounty, &s.usdc_mint),
        requester_ata,
        token_program: spl_token::id(),
    }
}

/// The eight `create_and_fund` arguments (SPEC 7.2). Tests that vary one
/// argument build the default and replace one field.
#[derive(Clone, Copy)]
struct CreateArgs {
    bounty_id: [u8; 16],
    reward_amount: u64,
    policy_hash: [u8; 32],
    eligibility_profile_hash: [u8; 32],
    required_assurance: u8,
    acceptance_window_secs: i64,
    completion_window_secs: i64,
    review_window_secs: i64,
}

fn create_args(bounty_id: [u8; 16], reward_amount: u64, required_assurance: u8) -> CreateArgs {
    CreateArgs {
        bounty_id,
        reward_amount,
        policy_hash: POLICY_HASH,
        eligibility_profile_hash: PROFILE_HASH,
        required_assurance,
        acceptance_window_secs: ACCEPTANCE_WINDOW,
        completion_window_secs: COMPLETION_WINDOW,
        review_window_secs: REVIEW_WINDOW,
    }
}

fn create_and_fund_ix(
    s: &Setup,
    bounty_id: [u8; 16],
    reward_amount: u64,
    required_assurance: u8,
    requester_ata: Pubkey,
) -> Instruction {
    let bounty = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let accounts = token_accounts(s, &bounty, requester_ata);
    create_and_fund_ix_with(s, create_args(bounty_id, reward_amount, required_assurance), accounts)
}

fn create_and_fund_ix_with(s: &Setup, args: CreateArgs, accounts: TokenAccounts) -> Instruction {
    let requester = s.requester.pubkey();
    let bounty = bounty_pda(&requester, &args.bounty_id);
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::CreateAndFund {
            bounty_id: args.bounty_id,
            reward_amount: args.reward_amount,
            policy_hash: args.policy_hash,
            eligibility_profile_hash: args.eligibility_profile_hash,
            required_assurance: args.required_assurance,
            acceptance_window_secs: args.acceptance_window_secs,
            completion_window_secs: args.completion_window_secs,
            review_window_secs: args.review_window_secs,
        }
        .data(),
        escrow::accounts::CreateAndFund {
            requester,
            config: accounts.config,
            bounty,
            usdc_mint: accounts.usdc_mint,
            bounty_vault: accounts.bounty_vault,
            requester_ata: accounts.requester_ata,
            token_program: accounts.token_program,
            associated_token_program: associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// `create_and_fund` with one argument varied and the default accounts.
fn create_and_fund_ix_args(s: &Setup, args: CreateArgs) -> Instruction {
    let bounty = bounty_pda(&s.requester.pubkey(), &args.bounty_id);
    let accounts = token_accounts(s, &bounty, s.requester_ata);
    create_and_fund_ix_with(s, args, accounts)
}

fn cancel_ix(s: &Setup, signer: Pubkey, bounty: Pubkey, requester_ata: Pubkey) -> Instruction {
    let accounts = token_accounts(s, &bounty, requester_ata);
    cancel_ix_with(signer, bounty, accounts)
}

fn cancel_ix_with(signer: Pubkey, bounty: Pubkey, accounts: TokenAccounts) -> Instruction {
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::Cancel {}.data(),
        escrow::accounts::Cancel {
            requester: signer,
            config: accounts.config,
            bounty,
            usdc_mint: accounts.usdc_mint,
            bounty_vault: accounts.bounty_vault,
            requester_ata: accounts.requester_ata,
            token_program: accounts.token_program,
        }
        .to_account_metas(None),
    )
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let account = svm.get_account(ata).unwrap();
    spl_token::state::Account::unpack(&account.data).unwrap().amount
}

fn read_bounty(svm: &LiteSVM, bounty: &Pubkey) -> Bounty {
    let account = svm.get_account(bounty).unwrap();
    Bounty::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[track_caller]
fn assert_named_error(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    name: &str,
) {
    let failed = match res {
        Ok(meta) => panic!("expected {name}, but transaction succeeded: {:?}", meta.logs),
        Err(failed) => failed,
    };
    let logs = failed.meta.logs.join("\n");
    assert!(
        logs.contains(&format!("Error Code: {name}")),
        "expected named error {name}; got err {:?} with logs:\n{logs}",
        failed.err,
    );
}

/// Like `assert_named_error`, but pins the account Anchor names as the cause.
/// Used where two constraints share an error name, so deleting one of them
/// cannot leave the test green. Echoes the matched line for `--nocapture`.
#[track_caller]
fn assert_named_error_at(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    name: &str,
    account: &str,
) {
    let failed = match res {
        Ok(meta) => panic!("expected {name} at {account}, but succeeded: {:?}", meta.logs),
        Err(failed) => failed,
    };
    let needle = format!("caused by account: {account}. Error Code: {name}");
    let line = failed.meta.logs.iter().find(|l| l.contains(&needle));
    let logs = failed.meta.logs.join("\n");
    let line = line.unwrap_or_else(|| {
        panic!("expected \"{needle}\"; got err {:?} with logs:\n{logs}", failed.err)
    });
    eprintln!("{line}");
}

// SPEC test 12: every section 4.1 field; vault equals reward_amount;
// platform_fee 0; requester down by exactly reward_amount; acceptance_cutoff
// equals clock plus window; every Option None; state Funded.
#[test]
fn t12_create_and_fund_succeeds() {
    let mut s = setup();
    let bounty_id = [1u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    let requester = s.requester.pubkey();
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let bounty_key = bounty_pda(&requester, &bounty_id);
    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.bounty_id, bounty_id);
    assert_eq!(bounty.requester, requester);
    assert_eq!(bounty.reward_amount, REWARD);
    assert_eq!(bounty.platform_fee, 0);
    assert_eq!(bounty.policy_hash, POLICY_HASH);
    assert_eq!(bounty.eligibility_profile_hash, PROFILE_HASH);
    assert_eq!(bounty.required_assurance, 3);
    assert_eq!(bounty.acceptance_window_secs, ACCEPTANCE_WINDOW);
    assert_eq!(bounty.completion_window_secs, COMPLETION_WINDOW);
    assert_eq!(bounty.review_window_secs, REVIEW_WINDOW);
    assert_eq!(bounty.acceptance_cutoff, NOW + ACCEPTANCE_WINDOW);
    assert_eq!(bounty.state, BountyState::Funded);
    let (_, expected_bump) = Pubkey::find_program_address(
        &[BOUNTY_SEED, requester.as_ref(), bounty_id.as_ref()],
        &escrow::id(),
    );
    assert_eq!(bounty.bump, expected_bump);
    assert_eq!(bounty.scout, None);
    assert_eq!(bounty.deadline, None);
    assert_eq!(bounty.submitted_at, None);
    assert_eq!(bounty.evidence_root, None);
    assert_eq!(bounty.achieved_assurance, None);

    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);
    assert_eq!(token_balance(&s.svm, &vault), REWARD);
    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE - REWARD);
}

// SPEC test 18: reward_amount of u64::MAX with a matching balance succeeds and
// the vault holds u64::MAX. The requester's balance is topped up to exactly
// u64::MAX first; total supply then equals u64::MAX, which the mint permits.
#[test]
fn t18_create_with_max_reward_succeeds() {
    let mut s = setup();
    let top_up = spl_token::instruction::mint_to(
        &spl_token::id(),
        &s.usdc_mint,
        &s.requester_ata,
        &s.requester.pubkey(),
        &[],
        u64::MAX - INITIAL_BALANCE,
    )
    .unwrap();
    send(&mut s.svm, &s.requester, &[top_up], &[&s.requester]).unwrap();
    assert_eq!(token_balance(&s.svm, &s.requester_ata), u64::MAX);

    let bounty_id = [18u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, u64::MAX, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let bounty_key = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.reward_amount, u64::MAX);
    assert_eq!(bounty.platform_fee, 0);
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);
    assert_eq!(token_balance(&s.svm, &vault), u64::MAX);
    assert_eq!(token_balance(&s.svm, &s.requester_ata), 0);
}

/// The one `BountyCancelled` in a transaction's logs. Decodes every
/// `Program data:` line, keeps those whose first eight bytes are Anchor's
/// discriminator for the event, and requires exactly one.
fn cancelled_event(meta: &TransactionMetadata) -> BountyCancelled {
    let events: Vec<BountyCancelled> = meta
        .logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .map(|b64| STANDARD.decode(b64).unwrap())
        .filter(|bytes| bytes.starts_with(BountyCancelled::DISCRIMINATOR))
        .map(|bytes| BountyCancelled::deserialize(&mut &bytes[8..]).unwrap())
        .collect();
    assert_eq!(events.len(), 1, "exactly one BountyCancelled; logs:\n{:#?}", meta.logs);
    events.into_iter().next().unwrap()
}

fn is_closed(svm: &LiteSVM, key: &Pubkey) -> bool {
    svm.get_account(key)
        .is_none_or(|a| a.lamports == 0 && a.data.is_empty())
}

// SPEC test 29: balance restored; vault and bounty closed; rent to the
// requester; BountyCancelled fields exact. A separate fee payer signs as
// payer so the requester's lamport delta is exactly the two rents.
#[test]
fn t29_cancel_succeeds() {
    let mut s = setup();
    let bounty_id = [2u8; 16];
    let bounty_key = fund_bounty(&mut s, bounty_id);
    let requester = s.requester.pubkey();
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);

    let relayer = Keypair::new();
    s.svm.airdrop(&relayer.pubkey(), 1_000_000_000).unwrap();
    let vault_rent = s.svm.get_account(&vault).unwrap().lamports;
    let bounty_rent = s.svm.get_account(&bounty_key).unwrap().lamports;
    let requester_before = s.svm.get_balance(&requester).unwrap();

    let ix = cancel_ix(&s, requester, bounty_key, s.requester_ata);
    let meta = send(&mut s.svm, &relayer, &[ix], &[&relayer, &s.requester]).unwrap();

    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE);
    assert!(is_closed(&s.svm, &vault), "vault closed");
    assert!(is_closed(&s.svm, &bounty_key), "bounty closed");
    let requester_after = s.svm.get_balance(&requester).unwrap();
    assert_eq!(requester_after - requester_before, vault_rent + bounty_rent);

    let event = cancelled_event(&meta);
    assert_eq!(event.bounty, bounty_key);
    assert_eq!(event.bounty_id, bounty_id);
    assert_eq!(event.requester, requester);
    assert_eq!(event.usdc_mint, s.usdc_mint);
    assert_eq!(event.reward_amount, REWARD);
    assert_eq!(event.refunded_amount, REWARD);
    assert_eq!(event.cancelled_at, NOW);
}

// SPEC test 38: tokens donated to the vault by a third party. Cancel
// succeeds; the requester receives reward plus donation; the vault closes;
// refunded_amount equals reward plus donation.
#[test]
fn t38_cancel_refunds_donated_tokens() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [38u8; 16]);
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);

    const DONATION: u64 = 1_234_567;
    let donor = Keypair::new();
    s.svm.airdrop(&donor.pubkey(), 1_000_000_000).unwrap();
    let donor_ata =
        create_funded_ata(&mut s.svm, &s.requester, &donor.pubkey(), &s.usdc_mint, DONATION);
    let donate = spl_token::instruction::transfer_checked(
        &spl_token::id(),
        &donor_ata,
        &s.usdc_mint,
        &vault,
        &donor.pubkey(),
        &[],
        DONATION,
        DECIMALS,
    )
    .unwrap();
    send(&mut s.svm, &donor, &[donate], &[&donor]).unwrap();
    assert_eq!(token_balance(&s.svm, &vault), REWARD + DONATION);

    let ix = cancel_ix(&s, s.requester.pubkey(), bounty_key, s.requester_ata);
    let meta = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE + DONATION);
    assert!(is_closed(&s.svm, &vault), "vault closed");
    let event = cancelled_event(&meta);
    assert_eq!(event.reward_amount, REWARD);
    assert_eq!(event.refunded_amount, REWARD + DONATION);
}

// SPEC test 41: a same-layout bounty owned by another program, planted
// (exploit test). One fault: the owner. The account is a byte-identical copy
// at the canonical address; Anchor's owner check fires in the field phase.
#[test]
fn t41_cancel_with_bounty_owned_by_other_program_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [41u8; 16]);
    let mut planted = s.svm.get_account(&bounty_key).unwrap();
    planted.owner = spl_token::id();
    s.svm.set_account(bounty_key, planted).unwrap();

    let ix = cancel_ix(&s, s.requester.pubkey(), bounty_key, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "AccountOwnedByWrongProgram");
}

/// A valid PDA for the bounty seeds at a bump other than the canonical one.
fn non_canonical_bounty_pda(requester: &Pubkey, bounty_id: &[u8; 16]) -> Pubkey {
    let seeds: &[&[u8]] = &[BOUNTY_SEED, requester.as_ref(), bounty_id.as_ref()];
    let (_, canonical) = Pubkey::find_program_address(seeds, &escrow::id());
    (0..canonical)
        .rev()
        .find_map(|bump| {
            Pubkey::create_program_address(&[seeds[0], seeds[1], seeds[2], &[bump]], &escrow::id())
                .ok()
        })
        .expect("a lower bump yields a valid PDA")
}

// SPEC test 94: a program-owned bounty at a non-canonical PDA address,
// planted (exploit test). One fault: the address. The copy keeps its stored
// canonical bump, as every program-created bounty does; Anchor re-derives
// with that bump and the address differs. The real vault is passed: `bounty`
// is declared before `bounty_vault`, so the seeds check fires before the
// vault's authority constraint could see the substitute.
//
// Limit stated: a plant that also rewrote the stored bump to the
// non-canonical one would pass Anchor's explicit-bump check. It is
// unreachable, because only `init` at the canonical bump creates an
// escrow-owned bounty, and no outsider can sign for a PDA.
#[test]
fn t94_cancel_with_bounty_at_non_canonical_pda_fails() {
    let mut s = setup();
    let bounty_id = [94u8; 16];
    let bounty_key = fund_bounty(&mut s, bounty_id);
    let fake = non_canonical_bounty_pda(&s.requester.pubkey(), &bounty_id);
    assert_ne!(fake, bounty_key);
    let planted = s.svm.get_account(&bounty_key).unwrap();
    s.svm.set_account(fake, planted).unwrap();

    let accounts = token_accounts(&s, &bounty_key, s.requester_ata);
    let ix = cancel_ix_with(s.requester.pubkey(), fake, accounts);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "ConstraintSeeds");
}

// SPEC test 91: missing signer, three cases: the create_and_fund requester,
// the cancel requester, and the accept Scout. A relayer pays and is the only
// signer; the named account's meta is demoted in the last instruction of the
// case. The accept case carries a valid voucher, so the missing signature is
// its only fault.
#[test]
fn t91_missing_signer_fails() {
    let mut s = setup();
    let requester = s.requester.pubkey();
    let relayer = Keypair::new();
    s.svm.airdrop(&relayer.pubkey(), 1_000_000_000).unwrap();
    let funded = fund_bounty(&mut s, [91u8; 16]);
    let to_accept = fund_bounty(&mut s, [93u8; 16]);
    let scout = new_scout(&mut s);
    let expires_at = NOW + VOUCHER_TTL;
    let voucher = voucher_ix(&s.svm, &s.eligibility, &to_accept, &scout.pubkey(), expires_at);

    let cases: [(Vec<Instruction>, Pubkey); 3] = [
        (
            vec![create_and_fund_ix(&s, [92u8; 16], REWARD, 3, s.requester_ata)],
            requester,
        ),
        (vec![cancel_ix(&s, requester, funded, s.requester_ata)], requester),
        (
            vec![voucher, accept_ix(scout.pubkey(), to_accept, expires_at, 0)],
            scout.pubkey(),
        ),
    ];
    assert_eq!(cases.len(), 3);
    for (mut ixs, demoted) in cases {
        let last = ixs.last_mut().unwrap();
        let meta = last.accounts.iter_mut().find(|m| m.pubkey == demoted).unwrap();
        assert!(meta.is_signer);
        meta.is_signer = false;
        let res = send(&mut s.svm, &relayer, &ixs, &[&relayer]);
        assert_named_error(res, "AccountNotSigner");
    }
}

// SPEC test 39: requester_ata set to the vault address. One fault: the token
// account. Anchor's duplicate-mutable-account check runs before per-field
// constraints (anchor-syn try_accounts: init, then duplicates, then access
// checks), so it names the fault first (D87).
#[test]
fn t39_cancel_with_vault_as_requester_ata_fails() {
    let mut s = setup();
    let bounty = fund_bounty(&mut s, [39u8; 16]);
    let vault = associated_token::get_associated_token_address(&bounty, &s.usdc_mint);

    let ix = cancel_ix(&s, s.requester.pubkey(), bounty, vault);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error_at(res, "ConstraintDuplicateMutableAccount", "requester_ata");
}

// SPEC test 40: close-then-reinit. cancel and create_and_fund with the same
// bounty_id in one transaction produce a fresh Funded bounty; vault equals
// reward_amount; every Option None; acceptance_cutoff equals clock plus window.
#[test]
fn t40_cancel_then_create_same_id_in_one_transaction() {
    let mut s = setup();
    let bounty_id = [40u8; 16];
    let bounty_key = fund_bounty(&mut s, bounty_id);
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);
    let requester = s.requester.pubkey();

    let cancel = cancel_ix(&s, requester, bounty_key, s.requester_ata);
    let create = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[cancel, create], &[&s.requester]);
    let meta = match res {
        Ok(meta) => meta,
        Err(failed) => panic!(
            "close-then-reinit failed: {:?}\nlogs:\n{}",
            failed.err,
            failed.meta.logs.join("\n")
        ),
    };
    eprintln!("{}", meta.logs.join("\n"));

    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.bounty_id, bounty_id);
    assert_eq!(bounty.requester, requester);
    assert_eq!(bounty.state, BountyState::Funded);
    assert_eq!(bounty.reward_amount, REWARD);
    assert_eq!(bounty.acceptance_cutoff, NOW + ACCEPTANCE_WINDOW);
    assert_eq!(bounty.scout, None);
    assert_eq!(bounty.deadline, None);
    assert_eq!(bounty.submitted_at, None);
    assert_eq!(bounty.evidence_root, None);
    assert_eq!(bounty.achieved_assurance, None);
    assert_eq!(token_balance(&s.svm, &vault), REWARD);
    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE - REWARD);
}

// SPEC test 30.
#[test]
fn t30_cancel_by_non_requester_fails() {
    let mut s = setup();
    let bounty_id = [3u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let mallory = Keypair::new();
    s.svm.airdrop(&mallory.pubkey(), 1_000_000_000).unwrap();
    let mallory_ata =
        create_funded_ata(&mut s.svm, &s.requester, &mallory.pubkey(), &s.usdc_mint, 0);

    let bounty_key = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let ix = cancel_ix(&s, mallory.pubkey(), bounty_key, mallory_ata);
    let res = send(&mut s.svm, &mallory, &[ix], &[&mallory]);
    assert_named_error(res, "UnauthorizedRequester");
}

// SPEC test 31: cancel after a real accept. One fault: the state. Guard of
// the existing state constraint, reached through `accept` rather than by
// rewriting the account (section 12 harness rules).
#[test]
fn t31_cancel_when_accepted_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [31u8; 16]);
    let scout = new_scout(&mut s);
    accept_with_voucher(&mut s, &scout, bounty_key, NOW + VOUCHER_TTL).unwrap();

    let ix = cancel_ix(&s, s.requester.pubkey(), bounty_key, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "BountyNotCancellable");
}

// SPEC test 13.
#[test]
fn t13_create_with_zero_reward_fails() {
    let mut s = setup();
    let ix = create_and_fund_ix(&s, [5u8; 16], 0, 3, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "InvalidRewardAmount");
}

// SPEC test 14: 5 gives AssuranceTooHigh; 4 succeeds.
#[test]
fn t14_create_with_assurance_above_max_fails() {
    let mut s = setup();
    let ix = create_and_fund_ix(&s, [7u8; 16], REWARD, 5, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "AssuranceTooHigh");

    let ix = create_and_fund_ix(&s, [8u8; 16], REWARD, 4, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();
    let bounty = read_bounty(&s.svm, &bounty_pda(&s.requester.pubkey(), &[8u8; 16]));
    assert_eq!(bounty.required_assurance, 4);
}

// SPEC test 19.
#[test]
fn t19_create_twice_with_same_bounty_id_fails() {
    let mut s = setup();
    let bounty_id = [8u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix.clone()], &[&s.requester]).unwrap();

    s.svm.expire_blockhash();
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    // The PDA collision is rejected by the system program during `init`
    // (AccountAlreadyInUse), before program code can run, so no custom
    // error is reachable for this case.
    let failed = res.expect_err("expected PDA collision to fail");
    let logs = failed.meta.logs.join("\n");
    assert!(
        logs.contains("already in use"),
        "expected system AccountAlreadyInUse; got err {:?} with logs:\n{logs}",
        failed.err,
    );
}

// SPEC test 33.
#[test]
fn t33_cancel_twice_fails() {
    let mut s = setup();
    let bounty_id = [9u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let bounty_key = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let ix = cancel_ix(&s, s.requester.pubkey(), bounty_key, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix.clone()], &[&s.requester]).unwrap();

    s.svm.expire_blockhash();
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    // The bounty account was closed by the first cancel; Anchor reports the
    // named error AccountNotInitialized when deserialising the closed account.
    assert_named_error(res, "AccountNotInitialized");
}

// SPEC test 21: correct mint, token account of another mint. One fault: the
// token account's mint.
#[test]
fn t21_create_with_token_account_of_other_mint_fails() {
    let mut s = setup();
    let wrong_mint = create_mint(&mut s.svm, &s.requester);
    let wrong_ata = create_funded_ata(
        &mut s.svm,
        &s.requester,
        &s.requester.pubkey(),
        &wrong_mint,
        INITIAL_BALANCE,
    );

    let ix = create_and_fund_ix(&s, [10u8; 16], REWARD, 3, wrong_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error_at(res, "MintMismatch", "requester_ata");
}

// SPEC test 20: a second real mint, with the requester's token account for it.
// One fault: the mint is not the configured one. The token account and the
// vault address are both derived from the substitute, so their own
// constraints hold and only the mint's address can fail.
#[test]
fn t20_create_with_other_mint_fails() {
    let mut s = setup();
    let other_mint = create_mint(&mut s.svm, &s.requester);
    let other_ata = create_funded_ata(
        &mut s.svm,
        &s.requester,
        &s.requester.pubkey(),
        &other_mint,
        INITIAL_BALANCE,
    );

    let bounty_id = [20u8; 16];
    let bounty = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let accounts = TokenAccounts {
        usdc_mint: other_mint,
        bounty_vault: associated_token::get_associated_token_address(&bounty, &other_mint),
        ..token_accounts(&s, &bounty, other_ata)
    };
    let ix = create_and_fund_ix_with(&s, create_args(bounty_id, REWARD, 3), accounts);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    // Pinned to usdc_mint: requester_ata's mint check shares the error name.
    assert_named_error_at(res, "MintMismatch", "usdc_mint");
}

// SPEC test 25: configuration substitutes, two cases, planted (exploit test).
// Case 1 plants, at the canonical config address, a byte-identical copy owned
// by the SPL Token program: one fault, the owner. Case 2 plants a
// byte-identical escrow-owned copy at a random address: one fault, the
// derivation. Anchor deserialises non-init accounts in the field phase, so
// the owner check fires before the bounty's init CPI; the seeds check is an
// access check, run after init, and the whole transaction reverts.
#[test]
fn t25_create_with_planted_config_fails() {
    // Case 1: same layout, owned by another program.
    let mut s = setup();
    let mut planted = s.svm.get_account(&s.config).unwrap();
    planted.owner = spl_token::id();
    s.svm.set_account(s.config, planted).unwrap();
    let ix = create_and_fund_ix(&s, [25u8; 16], REWARD, 3, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "AccountOwnedByWrongProgram");

    // Case 2: program-owned, at a non-PDA address.
    let mut s = setup();
    let fake_config = Pubkey::new_unique();
    let planted = s.svm.get_account(&s.config).unwrap();
    s.svm.set_account(fake_config, planted).unwrap();
    let bounty_id = [26u8; 16];
    let bounty = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let accounts = TokenAccounts {
        config: fake_config,
        ..token_accounts(&s, &bounty, s.requester_ata)
    };
    let ix = create_and_fund_ix_with(&s, create_args(bounty_id, REWARD, 3), accounts);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "ConstraintSeeds");
}

// SPEC test 26: the Token-2022 program ID as `token_program`. One fault: the
// program account. `Program<Token>` checks the key in the field phase.
#[test]
fn t26_create_with_token_2022_program_fails() {
    let mut s = setup();
    let bounty_id = [27u8; 16];
    let bounty = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let accounts = TokenAccounts {
        token_program: spl_token_2022::id(),
        ..token_accounts(&s, &bounty, s.requester_ata)
    };
    let ix = create_and_fund_ix_with(&s, create_args(bounty_id, REWARD, 3), accounts);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "InvalidProgramId");
}

/// A funded bounty for the cancel tests; returns its PDA.
fn fund_bounty(s: &mut Setup, bounty_id: [u8; 16]) -> Pubkey {
    let ix = create_and_fund_ix(s, bounty_id, REWARD, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();
    bounty_pda(&s.requester.pubkey(), &bounty_id)
}

// SPEC test 35: cancel with a token account of another mint. One fault: the
// token account's mint; its owner is the requester.
#[test]
fn t35_cancel_with_token_account_of_other_mint_fails() {
    let mut s = setup();
    let bounty = fund_bounty(&mut s, [35u8; 16]);
    let other_mint = create_mint(&mut s.svm, &s.requester);
    let other_ata =
        create_funded_ata(&mut s.svm, &s.requester, &s.requester.pubkey(), &other_mint, 0);

    let ix = cancel_ix(&s, s.requester.pubkey(), bounty, other_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error_at(res, "MintMismatch", "requester_ata");
}

// SPEC test 36: a mint account other than the configured mint. One fault: the
// mint. The real vault and token account are passed; `usdc_mint` is declared
// before `bounty_vault`, so its address constraint fires before the vault's
// associated-token constraint could see the substitute.
#[test]
fn t36_cancel_with_other_mint_fails() {
    let mut s = setup();
    let bounty = fund_bounty(&mut s, [36u8; 16]);
    let other_mint = create_mint(&mut s.svm, &s.requester);

    let accounts = TokenAccounts {
        usdc_mint: other_mint,
        ..token_accounts(&s, &bounty, s.requester_ata)
    };
    let ix = cancel_ix_with(s.requester.pubkey(), bounty, accounts);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    // Pinned to usdc_mint: requester_ata's mint check shares the error name.
    assert_named_error_at(res, "MintMismatch", "usdc_mint");
}

// SPEC test 37: the bounty's associated token account for another mint as the
// vault. One fault: the vault. It is a real, existing ATA whose authority is
// the bounty; only its mint differs.
#[test]
fn t37_cancel_with_vault_of_other_mint_fails() {
    let mut s = setup();
    let bounty = fund_bounty(&mut s, [37u8; 16]);
    let other_mint = create_mint(&mut s.svm, &s.requester);
    let other_vault = create_funded_ata(&mut s.svm, &s.requester, &bounty, &other_mint, 0);

    let accounts = TokenAccounts {
        bounty_vault: other_vault,
        ..token_accounts(&s, &bounty, s.requester_ata)
    };
    let ix = cancel_ix_with(s.requester.pubkey(), bounty, accounts);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "ConstraintAssociated");
}

// SPEC test 22: correct mint, token account owned by another wallet.
// One fault: the token account's owner. The requester signs and the mint is the
// configured one, so only the owner constraint can fire.
#[test]
fn t22_create_with_token_account_owned_by_other_wallet_fails() {
    let mut s = setup();
    let mallory = Keypair::new();
    let mallory_ata = create_funded_ata(
        &mut s.svm,
        &s.requester,
        &mallory.pubkey(),
        &s.usdc_mint,
        INITIAL_BALANCE,
    );

    let ix = create_and_fund_ix(&s, [22u8; 16], REWARD, 3, mallory_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "TokenAccountOwnerMismatch");
}

// SPEC test 34: cancel with a token account owned by another wallet.
// One fault: the token account's owner. The requester signs, the bounty is
// Funded, the vault is the bounty's own ATA and the mint is correct.
#[test]
fn t34_cancel_with_token_account_owned_by_other_wallet_fails() {
    let mut s = setup();
    let bounty_id = [34u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let mallory = Keypair::new();
    let mallory_ata =
        create_funded_ata(&mut s.svm, &s.requester, &mallory.pubkey(), &s.usdc_mint, 0);

    let bounty_key = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let ix = cancel_ix(&s, s.requester.pubkey(), bounty_key, mallory_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "TokenAccountOwnerMismatch");
}

// SPEC test 28: every section 10 variant has its listed code (D75). The table
// is the section 10 table; Anchor's own conversion supplies the on-chain code.
#[test]
fn t28_every_error_variant_has_its_listed_code() {
    use escrow::error::EscrowError as E;
    let table: [(E, u32); 34] = [
        (E::InvalidRewardAmount, 6000),
        (E::DeadlineInPast, 6001),
        (E::AssuranceTooHigh, 6002),
        (E::MintMismatch, 6003),
        (E::UnauthorizedRequester, 6004),
        (E::BountyNotCancellable, 6005),
        (E::AmountOverflow, 6006),
        (E::TokenAccountOwnerMismatch, 6007),
        (E::InvalidAcceptanceWindow, 6008),
        (E::InvalidCompletionWindow, 6009),
        (E::InvalidReviewWindow, 6010),
        (E::TimestampOverflow, 6011),
        (E::InvalidProgramData, 6012),
        (E::ProgramNotUpgradeable, 6013),
        (E::UnauthorizedInitializer, 6014),
        (E::AuthoritiesNotDistinct, 6015),
        (E::InvalidAuthorityKey, 6016),
        (E::BountyNotAcceptable, 6017),
        (E::AcceptanceWindowClosed, 6018),
        (E::ScoutIsRequester, 6019),
        (E::VoucherExpired, 6020),
        (E::BountyNotAttestable, 6021),
        (E::SubmissionDeadlinePassed, 6022),
        (E::AchievedAssuranceOutOfRange, 6023),
        (E::InsufficientAssurance, 6024),
        (E::InvocationNotTopLevel, 6025),
        (E::InvalidInstructionsSysvar, 6026),
        (E::VerificationIndexInvalid, 6027),
        (E::NotEd25519Instruction, 6028),
        (E::MalformedVerificationInstruction, 6029),
        (E::VerificationAuthorityMismatch, 6030),
        (E::VerificationMessageMismatch, 6031),
        (E::VaultBalanceBelowReward, 6032),
        (E::StateInvariantViolated, 6033),
    ];
    assert_eq!(table.len(), 34, "section 10 lists 34 variants");
    for (variant, expected) in table {
        assert_eq!(u32::from(variant), expected, "{variant:?}");
    }
}

// ---------------------------------------------------------------------------
// SPEC 12.1: initialize
// ---------------------------------------------------------------------------

// SPEC test 1: stores exactly the supplied values and the canonical bump.
// Harness setup per D83: ProgramData's upgrade authority is overwritten
// before the call (see `set_upgrade_authority`).
#[test]
fn t01_initialize_stores_supplied_values() {
    let mut s = setup_bare();
    let authority = s.upgrade_authority.pubkey();
    set_upgrade_authority(&mut s.svm, &escrow::id(), &authority);

    let ix = initialize_ix(&s, authority, s.usdc_mint);
    send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]).unwrap();

    let (expected_address, expected_bump) =
        Pubkey::find_program_address(&[CONFIG_SEED], &escrow::id());
    assert_eq!(s.config, expected_address);
    let config = read_config(&s.svm, &s.config);
    assert_eq!(config.deployment_id, DEPLOYMENT_ID);
    assert_eq!(config.usdc_mint, s.usdc_mint);
    assert_eq!(config.eligibility_authority, s.eligibility.pubkey());
    assert_eq!(config.attester_authority, s.attester.pubkey());
    assert_eq!(config.arbiter_authority, s.arbiter.pubkey());
    assert_eq!(config.bump, expected_bump);
}

// SPEC test 2: signer other than the recorded upgrade authority.
// One fault: the signer. ProgramData records the harness authority; the
// requester signs and pays instead.
#[test]
fn t02_initialize_by_non_upgrade_authority_fails() {
    let mut s = setup_uninitialized();
    let ix = initialize_ix(&s, s.requester.pubkey(), s.usdc_mint);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "UnauthorizedInitializer");
}

// SPEC test 3: a real ProgramData account of another program.
// One fault: the ProgramData address. A second copy of the program is loaded
// under a fresh id, so its ProgramData is genuine, loader-owned, and records
// the same upgrade authority as the escrow's; only the derivation differs.
#[test]
fn t03_initialize_with_other_programs_program_data_fails() {
    let mut s = setup_uninitialized();
    let other_program = Pubkey::new_unique();
    s.svm.add_program(other_program, PROGRAM_BYTES).unwrap();
    let authority = s.upgrade_authority.pubkey();
    set_upgrade_authority(&mut s.svm, &other_program, &authority);

    let ix = initialize_ix_full(
        authority,
        s.usdc_mint,
        program_data_address(&other_program),
        [s.eligibility.pubkey(), s.attester.pubkey(), s.arbiter.pubkey()],
    );
    let res = send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]);
    assert_named_error(res, "InvalidProgramData");
}

// SPEC test 4: recorded authority `None`, the harness default.
// One fault: ProgramData records no authority. `setup_bare` performs no
// overwrite, so litesvm's default is what the program sees.
#[test]
fn t04_initialize_with_no_recorded_authority_fails() {
    let mut s = setup_bare();
    let authority = s.upgrade_authority.pubkey();
    let ix = initialize_ix(&s, authority, s.usdc_mint);
    let res = send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]);
    assert_named_error(res, "ProgramNotUpgradeable");
}

// SPEC test 5: second initialize fails in the system program.
#[test]
fn t05_second_initialize_fails() {
    let mut s = setup();
    s.svm.expire_blockhash();
    let ix = initialize_ix(&s, s.upgrade_authority.pubkey(), s.usdc_mint);
    let res = send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]);
    let failed = res.expect_err("expected the config PDA collision to fail");
    let logs = failed.meta.logs.join("\n");
    assert!(
        logs.contains("already in use"),
        "expected system AccountAlreadyInUse; got err {:?} with logs:\n{logs}",
        failed.err,
    );
}

fn initialize_with_keys(
    keys: [Pubkey; 3],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let mut s = setup_uninitialized();
    let ix = initialize_ix_full(
        s.upgrade_authority.pubkey(),
        s.usdc_mint,
        program_data_address(&escrow::id()),
        keys,
    );
    send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority])
}

// SPEC test 6: eligibility equals attester.
#[test]
fn t06_initialize_with_eligibility_equal_attester_fails() {
    let k = Pubkey::new_unique();
    let res = initialize_with_keys([k, k, Pubkey::new_unique()]);
    assert_named_error(res, "AuthoritiesNotDistinct");
}

// SPEC test 7: eligibility equals arbiter.
#[test]
fn t07_initialize_with_eligibility_equal_arbiter_fails() {
    let k = Pubkey::new_unique();
    let res = initialize_with_keys([k, Pubkey::new_unique(), k]);
    assert_named_error(res, "AuthoritiesNotDistinct");
}

// SPEC test 8: attester equals arbiter.
#[test]
fn t08_initialize_with_attester_equal_arbiter_fails() {
    let k = Pubkey::new_unique();
    let res = initialize_with_keys([Pubkey::new_unique(), k, k]);
    assert_named_error(res, "AuthoritiesNotDistinct");
}

// SPEC test 9: each authority all-zero in turn, three cases.
#[test]
fn t09_initialize_with_zero_authority_fails() {
    let zero = Pubkey::default();
    let cases: [[Pubkey; 3]; 3] = [
        [zero, Pubkey::new_unique(), Pubkey::new_unique()],
        [Pubkey::new_unique(), zero, Pubkey::new_unique()],
        [Pubkey::new_unique(), Pubkey::new_unique(), zero],
    ];
    assert_eq!(cases.len(), 3);
    for keys in cases {
        assert_named_error(initialize_with_keys(keys), "InvalidAuthorityKey");
    }
}

// SPEC test 10: a Token-2022 mint. One fault: the mint's owning program.
#[test]
fn t10_initialize_with_token_2022_mint_fails() {
    let mut s = setup_uninitialized();
    let mint = Keypair::new();
    let rent = s
        .svm
        .minimum_balance_for_rent_exemption(spl_token_2022::state::Mint::LEN);
    let ixs = [
        system_instruction::create_account(
            &s.requester.pubkey(),
            &mint.pubkey(),
            rent,
            spl_token_2022::state::Mint::LEN as u64,
            &spl_token_2022::id(),
        ),
        spl_token_2022::instruction::initialize_mint2(
            &spl_token_2022::id(),
            &mint.pubkey(),
            &s.requester.pubkey(),
            None,
            DECIMALS,
        )
        .unwrap(),
    ];
    send(&mut s.svm, &s.requester, &ixs, &[&s.requester, &mint]).unwrap();

    let ix = initialize_ix(&s, s.upgrade_authority.pubkey(), mint.pubkey());
    let res = send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]);
    assert_named_error(res, "AccountOwnedByWrongProgram");
}

// SPEC test 11: a classic token account passed as the mint. One fault: the
// account's data is a token account, not a mint; the owner is correct.
#[test]
fn t11_initialize_with_token_account_as_mint_fails() {
    let mut s = setup_uninitialized();
    let ix = initialize_ix(&s, s.upgrade_authority.pubkey(), s.requester_ata);
    let res = send(&mut s.svm, &s.upgrade_authority, &[ix], &[&s.upgrade_authority]);
    assert_named_error(res, "InvalidAccountData");
}

// ---------------------------------------------------------------------------
// SPEC 12.7: layout
// ---------------------------------------------------------------------------

// SPEC test 92: serialised layouts match sections 3 and 4.1. Configuration:
// fixed offsets, 138 bytes. Bounty: fixed offsets, `None` as one byte (176
// bytes all-None), each `Option` tag at its computed offset when all-Some
// (257 bytes), and the on-chain account is 257 bytes.
#[test]
fn t92_serialised_layouts_match_spec() {
    let keys: [Pubkey; 4] = std::array::from_fn(|_| Pubkey::new_unique());
    let config = Config {
        deployment_id: 7,
        usdc_mint: keys[0],
        eligibility_authority: keys[1],
        attester_authority: keys[2],
        arbiter_authority: keys[3],
        bump: 250,
    };
    let mut buf = Vec::new();
    config.try_serialize(&mut buf).unwrap();
    assert_eq!(Config::INIT_SPACE, 130);
    assert_eq!(buf.len(), 138);
    assert_eq!(buf[8], 7);
    assert_eq!(&buf[9..41], keys[0].as_ref());
    assert_eq!(&buf[41..73], keys[1].as_ref());
    assert_eq!(&buf[73..105], keys[2].as_ref());
    assert_eq!(&buf[105..137], keys[3].as_ref());
    assert_eq!(buf[137], 250);

    let mut s = setup();
    assert_eq!(s.svm.get_account(&s.config).unwrap().data.len(), 138);

    // Bounty, all-None.
    let requester = Pubkey::new_unique();
    let mut bounty = Bounty {
        bounty_id: [1u8; 16],
        requester,
        reward_amount: 2,
        platform_fee: 0,
        policy_hash: [3u8; 32],
        eligibility_profile_hash: [4u8; 32],
        required_assurance: 5,
        acceptance_window_secs: 6,
        completion_window_secs: 7,
        review_window_secs: 8,
        acceptance_cutoff: 9,
        state: BountyState::Submitted,
        bump: 251,
        scout: None,
        deadline: None,
        submitted_at: None,
        evidence_root: None,
        achieved_assurance: None,
    };
    let mut buf = Vec::new();
    bounty.try_serialize(&mut buf).unwrap();
    assert_eq!(Bounty::INIT_SPACE, 249);
    assert_eq!(buf.len(), 176);
    assert_eq!(&buf[8..24], &[1u8; 16]);
    assert_eq!(&buf[24..56], requester.as_ref());
    assert_eq!(&buf[56..64], &2u64.to_le_bytes());
    assert_eq!(&buf[64..72], &0u64.to_le_bytes());
    assert_eq!(&buf[72..104], &[3u8; 32]);
    assert_eq!(&buf[104..136], &[4u8; 32]);
    assert_eq!(buf[136], 5);
    assert_eq!(&buf[137..145], &6i64.to_le_bytes());
    assert_eq!(&buf[145..153], &7i64.to_le_bytes());
    assert_eq!(&buf[153..161], &8i64.to_le_bytes());
    assert_eq!(&buf[161..169], &9i64.to_le_bytes());
    assert_eq!(buf[169], 2, "state Submitted");
    assert_eq!(buf[170], 251, "bump");
    assert_eq!(&buf[171..176], &[0u8; 5], "five None tags");

    // Bounty, all-Some: tags at 171, 204, 213, 222, 255.
    let scout = Pubkey::new_unique();
    bounty.scout = Some(scout);
    bounty.deadline = Some(10);
    bounty.submitted_at = Some(11);
    bounty.evidence_root = Some([12u8; 32]);
    bounty.achieved_assurance = Some(13);
    let mut buf = Vec::new();
    bounty.try_serialize(&mut buf).unwrap();
    assert_eq!(buf.len(), 257);
    assert_eq!(buf[171], 1);
    assert_eq!(&buf[172..204], scout.as_ref());
    assert_eq!(buf[204], 1);
    assert_eq!(&buf[205..213], &10i64.to_le_bytes());
    assert_eq!(buf[213], 1);
    assert_eq!(&buf[214..222], &11i64.to_le_bytes());
    assert_eq!(buf[222], 1);
    assert_eq!(&buf[223..255], &[12u8; 32]);
    assert_eq!(buf[255], 1);
    assert_eq!(buf[256], 13);

    // On-chain: the account is allocated at the maximum size.
    let bounty_key = fund_bounty(&mut s, [92u8; 16]);
    assert_eq!(s.svm.get_account(&bounty_key).unwrap().data.len(), 257);
}

// SPEC test 93: BountyState discriminants Funded 0, Accepted 1, Submitted 2,
// both as the Rust discriminant and as the serialised byte.
#[test]
fn t93_bounty_state_discriminants() {
    use anchor_lang::AnchorSerialize;
    let cases = [
        (BountyState::Funded, 0u8),
        (BountyState::Accepted, 1u8),
        (BountyState::Submitted, 2u8),
    ];
    assert_eq!(cases.len(), 3);
    for (state, expected) in cases {
        assert_eq!(state as u8, expected, "{state:?}");
        let mut buf = Vec::new();
        state.serialize(&mut buf).unwrap();
        assert_eq!(buf, vec![expected], "{state:?}");
    }
}

// ---------------------------------------------------------------------------
// SPEC 12.2: create_and_fund, windows and arguments (D81, D84)
// ---------------------------------------------------------------------------

/// Tests 15 to 17. `set` writes the window under test into the arguments.
/// Failing cases: 0, minus 1, ceiling plus 1. Passing cases: 1 and the
/// ceiling. Each case funds its own bounty_id.
fn window_cases(
    set: fn(&mut CreateArgs, i64),
    read: fn(&Bounty) -> i64,
    ceiling: i64,
    error: &str,
    id_base: u8,
) {
    let mut s = setup();
    let failing = [0, -1, ceiling + 1];
    let passing = [1, ceiling];
    assert_eq!(failing.len(), 3);
    assert_eq!(passing.len(), 2);

    for (i, value) in failing.into_iter().enumerate() {
        let mut args = create_args([id_base + i as u8; 16], REWARD, 3);
        set(&mut args, value);
        let ix = create_and_fund_ix_args(&s, args);
        let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
        assert_named_error(res, error);
    }
    for (i, value) in passing.into_iter().enumerate() {
        let bounty_id = [id_base + 3 + i as u8; 16];
        let mut args = create_args(bounty_id, REWARD, 3);
        set(&mut args, value);
        let ix = create_and_fund_ix_args(&s, args);
        send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();
        let bounty = read_bounty(&s.svm, &bounty_pda(&s.requester.pubkey(), &bounty_id));
        assert_eq!(read(&bounty), value);
    }
}

// SPEC test 15: acceptance window at 0, minus 1 and 2592001 fail; 1 and
// 2592000 succeed.
#[test]
fn t15_acceptance_window_bounds() {
    window_cases(
        |a, v| a.acceptance_window_secs = v,
        |b| b.acceptance_window_secs,
        2_592_000,
        "InvalidAcceptanceWindow",
        150,
    );
}

// SPEC test 16: completion window, the same cases.
#[test]
fn t16_completion_window_bounds() {
    window_cases(
        |a, v| a.completion_window_secs = v,
        |b| b.completion_window_secs,
        2_592_000,
        "InvalidCompletionWindow",
        160,
    );
}

// SPEC test 17: review window at 0, minus 1 and 86401 fail; 1 and 86400
// succeed.
#[test]
fn t17_review_window_bounds() {
    window_cases(
        |a, v| a.review_window_secs = v,
        |b| b.review_window_secs,
        86_400,
        "InvalidReviewWindow",
        170,
    );
}

// SPEC test 23: the generated IDL lists exactly the eight section 7.2
// arguments, in order (D67, D74, D82). Read from the build output at run
// time, so it is the file `anchor build` wrote in the same run; a missing
// file is a failure, never a skip.
#[test]
fn t23_idl_lists_exactly_the_eight_arguments() {
    let path = concat!(env!("CARGO_TARGET_TMPDIR"), "/../idl/escrow.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("IDL missing at {path}: {e}; run anchor build"));
    let idl: serde_json::Value = serde_json::from_str(&text).unwrap();
    let ix = idl["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|ix| ix["name"] == "create_and_fund")
        .expect("create_and_fund in IDL");
    let args: Vec<&str> = ix["args"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        args,
        [
            "bounty_id",
            "reward_amount",
            "policy_hash",
            "eligibility_profile_hash",
            "required_assurance",
            "acceptance_window_secs",
            "completion_window_secs",
            "review_window_secs",
        ]
    );
    let accounts: Vec<&str> = ix["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    for removed in ["arbiter_authority", "attester_authority"] {
        assert!(!accounts.contains(&removed), "{removed} still in accounts");
    }
}

// SPEC test 24: eligibility_profile_hash stored byte for byte, including
// all-zero and all-ones (D84). Each case funds its own bounty_id.
#[test]
fn t24_eligibility_profile_hash_stored_byte_for_byte() {
    let mut s = setup();
    let cases: [[u8; 32]; 3] = [[0u8; 32], [0xffu8; 32], std::array::from_fn(|i| i as u8)];
    assert_eq!(cases.len(), 3);
    for (i, hash) in cases.into_iter().enumerate() {
        let bounty_id = [240 + i as u8; 16];
        let mut args = create_args(bounty_id, REWARD, 3);
        args.eligibility_profile_hash = hash;
        let ix = create_and_fund_ix_args(&s, args);
        send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();
        let bounty = read_bounty(&s.svm, &bounty_pda(&s.requester.pubkey(), &bounty_id));
        assert_eq!(bounty.eligibility_profile_hash, hash);
    }
}

// SPEC test 27: clock set so clock plus acceptance window exceeds i64::MAX.
// One fault: the clock. The window itself is within bounds.
#[test]
fn t27_create_with_timestamp_overflow_fails() {
    let mut s = setup();
    let mut clock = s.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = i64::MAX - 10;
    s.svm.set_sysvar::<Clock>(&clock);

    let ix = create_and_fund_ix(&s, [27u8; 16], REWARD, 3, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "TimestampOverflow");
}

// ---------------------------------------------------------------------------
// SPEC 12.4: accept (D68, D71, D81, D86)
// ---------------------------------------------------------------------------

/// A published layout table: each field's name, offset and width, and the
/// schema's total length (MESSAGES.md sections 3 and 4, `vectors.json`).
fn layout(name: &str) -> (Vec<(String, usize, usize)>, usize) {
    let doc: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let table = &doc["layouts"][name];
    let fields = table["fields"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["field"].as_str().unwrap().to_string(),
                f["offset"].as_u64().unwrap() as usize,
                f["width"].as_u64().unwrap() as usize,
            )
        })
        .collect();
    (fields, table["total_bytes"].as_u64().unwrap() as usize)
}

fn hex(s: &str) -> Vec<u8> {
    assert_eq!(s.len() % 2, 0, "odd hex length");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// Test-side `BOUNTYCAM_ELIGIBILITY_V1`: every field placed at the published
/// table's offset with the table's width, from bounty state and the given
/// Scout and expiry. Independent of the program's builder, which test 90
/// verifies against the vectors separately.
fn eligibility_message(bounty: &Bounty, scout: &Pubkey, expires_at: i64) -> Vec<u8> {
    let (fields, total) = layout("BOUNTYCAM_ELIGIBILITY_V1");
    let mut out = vec![0u8; total];
    for (name, offset, width) in &fields {
        let bytes: Vec<u8> = match name.as_str() {
            "domain_tag" => b"BOUNTYCAM_ELIGIBILITY_V1".to_vec(),
            "schema_version" => 1u16.to_le_bytes().to_vec(),
            "deployment_id" => vec![DEPLOYMENT_ID],
            "program_id" => escrow::id().to_bytes().to_vec(),
            "bounty_id" => bounty.bounty_id.to_vec(),
            "requester" => bounty.requester.to_bytes().to_vec(),
            "scout" => scout.to_bytes().to_vec(),
            "policy_hash" => bounty.policy_hash.to_vec(),
            "eligibility_profile_hash" => bounty.eligibility_profile_hash.to_vec(),
            "required_assurance" => vec![bounty.required_assurance],
            "expires_at" => expires_at.to_le_bytes().to_vec(),
            other => panic!("unknown eligibility field {other}"),
        };
        assert_eq!(bytes.len(), *width, "{name}");
        out[*offset..*offset + *width].copy_from_slice(&bytes);
    }
    out
}

/// The canonical designated instruction (SPEC 6.1), built only by
/// `solana-ed25519-program` 3.0.0 so test and program cannot share one
/// misreading of the offset table (D89).
fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    let signature: [u8; 64] = signer.sign_message(message).as_ref().try_into().unwrap();
    new_ed25519_instruction_with_signature(message, &signature, &signer.pubkey().to_bytes())
}

/// A voucher for `scout` over the bounty's current state, signed by the
/// given key (normally the configured eligibility authority).
fn voucher_ix(
    svm: &LiteSVM,
    signer: &Keypair,
    bounty: &Pubkey,
    scout: &Pubkey,
    expires_at: i64,
) -> Instruction {
    let state = read_bounty(svm, bounty);
    ed25519_ix(signer, &eligibility_message(&state, scout, expires_at))
}

fn accept_ix(scout: Pubkey, bounty: Pubkey, expires_at: i64, index: u16) -> Instruction {
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::Accept {
            expires_at,
            verification_instruction_index: index,
        }
        .data(),
        escrow::accounts::Accept {
            scout,
            config: config_pda(),
            bounty,
            instructions_sysvar: solana_instructions_sysvar::ID,
        }
        .to_account_metas(None),
    )
}

/// `[verification, accept]` with the designated index 0; the Scout pays and
/// is the only signer.
fn accept_tx(
    svm: &mut LiteSVM,
    scout: &Keypair,
    bounty: Pubkey,
    expires_at: i64,
    verification: Instruction,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let accept = accept_ix(scout.pubkey(), bounty, expires_at, 0);
    send(svm, scout, &[verification, accept], &[scout])
}

/// The default accept: a voucher for this Scout signed by the configured
/// eligibility authority, then `accept`.
fn accept_with_voucher(
    s: &mut Setup,
    scout: &Keypair,
    bounty: Pubkey,
    expires_at: i64,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let voucher = voucher_ix(&s.svm, &s.eligibility, &bounty, &scout.pubkey(), expires_at);
    accept_tx(&mut s.svm, scout, bounty, expires_at, voucher)
}

fn new_scout(s: &mut Setup) -> Keypair {
    let scout = Keypair::new();
    s.svm.airdrop(&scout.pubkey(), 1_000_000_000).unwrap();
    scout
}

fn set_clock(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar::<Clock>(&clock);
}

/// Wrap `inner` in the test-only caller's `forward` (D90): the escrow program
/// account first, then the inner metas unchanged; data is the discriminator,
/// then the inner data as a borsh `Vec<u8>` (4-byte little-endian length).
fn via_cpi(inner: Instruction) -> Instruction {
    let mut accounts = vec![AccountMeta::new_readonly(escrow::id(), false)];
    accounts.extend(inner.accounts);
    let mut data = FORWARD_DISCRIMINATOR.to_vec();
    data.extend((inner.data.len() as u32).to_le_bytes());
    data.extend(inner.data);
    Instruction {
        program_id: CPI_CALLER_ID,
        accounts,
        data,
    }
}

/// Every field `create_and_fund` wrote, compared between two reads.
fn assert_fixed_fields_equal(a: &Bounty, b: &Bounty) {
    assert_eq!(a.bounty_id, b.bounty_id);
    assert_eq!(a.requester, b.requester);
    assert_eq!(a.reward_amount, b.reward_amount);
    assert_eq!(a.platform_fee, b.platform_fee);
    assert_eq!(a.policy_hash, b.policy_hash);
    assert_eq!(a.eligibility_profile_hash, b.eligibility_profile_hash);
    assert_eq!(a.required_assurance, b.required_assurance);
    assert_eq!(a.acceptance_window_secs, b.acceptance_window_secs);
    assert_eq!(a.completion_window_secs, b.completion_window_secs);
    assert_eq!(a.review_window_secs, b.review_window_secs);
    assert_eq!(a.acceptance_cutoff, b.acceptance_cutoff);
    assert_eq!(a.bump, b.bump);
}

// SPEC test 42: scout stored; deadline equals clock plus completion window;
// state Accepted; the other Options still None; every fixed field unchanged;
// no token balance changes anywhere.
#[test]
fn t42_accept_succeeds() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [42u8; 16]);
    let before = read_bounty(&s.svm, &bounty_key);
    let scout = new_scout(&mut s);
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);

    accept_with_voucher(&mut s, &scout, bounty_key, NOW + VOUCHER_TTL).unwrap();

    let after = read_bounty(&s.svm, &bounty_key);
    assert_eq!(after.scout, Some(scout.pubkey()));
    assert_eq!(after.deadline, Some(NOW + COMPLETION_WINDOW));
    assert_eq!(after.state, BountyState::Accepted);
    assert_eq!(after.submitted_at, None);
    assert_eq!(after.evidence_root, None);
    assert_eq!(after.achieved_assurance, None);
    assert_fixed_fields_equal(&before, &after);

    assert_eq!(token_balance(&s.svm, &vault), REWARD);
    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE - REWARD);
    let scout_ata = associated_token::get_associated_token_address(&scout.pubkey(), &s.usdc_mint);
    assert!(s.svm.get_account(&scout_ata).is_none(), "no Scout token account exists");
}

// SPEC test 43: at exactly acceptance_cutoff succeeds (D81). The voucher
// expires one second later so expiry is not in play.
#[test]
fn t43_accept_at_exactly_cutoff_succeeds() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [43u8; 16]);
    let scout = new_scout(&mut s);
    let cutoff = NOW + ACCEPTANCE_WINDOW;
    assert_eq!(read_bounty(&s.svm, &bounty_key).acceptance_cutoff, cutoff);
    set_clock(&mut s.svm, cutoff);

    accept_with_voucher(&mut s, &scout, bounty_key, cutoff + 1).unwrap();
    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.state, BountyState::Accepted);
    assert_eq!(bounty.deadline, Some(cutoff + COMPLETION_WINDOW));
}

// SPEC test 44: one second after acceptance_cutoff. One fault: the clock;
// the voucher is valid and unexpired.
#[test]
fn t44_accept_one_second_after_cutoff_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [44u8; 16]);
    let scout = new_scout(&mut s);
    let cutoff = NOW + ACCEPTANCE_WINDOW;
    set_clock(&mut s.svm, cutoff + 1);

    let res = accept_with_voucher(&mut s, &scout, bounty_key, cutoff + 100);
    assert_named_error(res, "AcceptanceWindowClosed");
}

// SPEC test 45: at exactly expires_at succeeds.
#[test]
fn t45_accept_at_exactly_expires_at_succeeds() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [45u8; 16]);
    let scout = new_scout(&mut s);

    accept_with_voucher(&mut s, &scout, bounty_key, NOW).unwrap();
    assert_eq!(read_bounty(&s.svm, &bounty_key).state, BountyState::Accepted);
}

// SPEC test 46: one second after expires_at. One fault: the voucher's expiry;
// the cutoff is untouched.
#[test]
fn t46_accept_one_second_after_expires_at_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [46u8; 16]);
    let scout = new_scout(&mut s);

    let res = accept_with_voucher(&mut s, &scout, bounty_key, NOW - 1);
    assert_named_error(res, "VoucherExpired");
}

// SPEC test 47: a wallet other than the voucher's Scout signs and submits a
// valid voucher. One fault: the signer, which is spliced into the
// reconstruction (SPEC 7.4, D68). The wallet is not the requester.
#[test]
fn t47_accept_by_wallet_other_than_voucher_scout_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [47u8; 16]);
    let named = new_scout(&mut s);
    let other = new_scout(&mut s);
    let expires_at = NOW + VOUCHER_TTL;
    let voucher = voucher_ix(&s.svm, &s.eligibility, &bounty_key, &named.pubkey(), expires_at);

    let res = accept_tx(&mut s.svm, &other, bounty_key, expires_at, voucher);
    assert_named_error(res, "VerificationMessageMismatch");
}

// SPEC test 48: a valid voucher naming the requester, signed by the requester.
// One fault: the identity. Check 3 precedes verification, and the voucher
// would verify, so nothing else can fire.
#[test]
fn t48_requester_accepting_own_bounty_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [48u8; 16]);
    let requester = s.requester.pubkey();
    let expires_at = NOW + VOUCHER_TTL;
    let voucher = voucher_ix(&s.svm, &s.eligibility, &bounty_key, &requester, expires_at);

    let res = accept_tx(&mut s.svm, &s.requester, bounty_key, expires_at, voucher);
    assert_named_error(res, "ScoutIsRequester");
}

// SPEC test 49: a second Scout with its own valid voucher after the first
// accept. One fault: the state (D68).
#[test]
fn t49_second_scout_after_accept_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [49u8; 16]);
    let first = new_scout(&mut s);
    let second = new_scout(&mut s);
    accept_with_voucher(&mut s, &first, bounty_key, NOW + VOUCHER_TTL).unwrap();

    let res = accept_with_voucher(&mut s, &second, bounty_key, NOW + VOUCHER_TTL);
    assert_named_error(res, "BountyNotAcceptable");
}

// SPEC test 50: the correct voucher message signed by the attester, the
// arbiter and a fresh key, three cases. One fault: the verifying key.
#[test]
fn t50_voucher_signed_by_non_eligibility_key_fails() {
    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [50u8; 16]);
    let scout = new_scout(&mut s);
    let expires_at = NOW + VOUCHER_TTL;
    let state = read_bounty(&s.svm, &bounty_key);
    let message = eligibility_message(&state, &scout.pubkey(), expires_at);

    let signers: [(&str, Keypair); 3] = [
        ("attester", s.attester.insecure_clone()),
        ("arbiter", s.arbiter.insecure_clone()),
        ("fresh key", Keypair::new()),
    ];
    assert_eq!(signers.len(), 3);
    for (name, signer) in &signers {
        eprintln!("case: signed by the {name}");
        let ix = ed25519_ix(signer, &message);
        let res = accept_tx(&mut s.svm, &scout, bounty_key, expires_at, ix);
        assert_named_error(res, "VerificationAuthorityMismatch");
    }
}

// SPEC test 51: one mutation per signed voucher field, eleven cases. The
// fields and their offsets come from the published layout table; each case
// flips one bit of the signed message inside that field and leaves the
// arguments unchanged. One fault: one signed field.
#[test]
fn t51_voucher_field_mutations_fail() {
    let (fields, _) = layout("BOUNTYCAM_ELIGIBILITY_V1");
    let names: Vec<&str> = fields.iter().map(|f| f.0.as_str()).collect();
    assert_eq!(
        names,
        [
            "domain_tag",
            "schema_version",
            "deployment_id",
            "program_id",
            "bounty_id",
            "requester",
            "scout",
            "policy_hash",
            "eligibility_profile_hash",
            "required_assurance",
            "expires_at",
        ],
        "MESSAGES.md section 4 fields, in order"
    );
    assert_eq!(fields.len(), 11);

    let mut s = setup();
    let bounty_key = fund_bounty(&mut s, [51u8; 16]);
    let scout = new_scout(&mut s);
    let expires_at = NOW + VOUCHER_TTL;
    let state = read_bounty(&s.svm, &bounty_key);
    let message = eligibility_message(&state, &scout.pubkey(), expires_at);

    for (name, offset, _width) in &fields {
        eprintln!("case: {name} at offset {offset}");
        let mut mutated = message.clone();
        mutated[*offset] ^= 0x01;
        assert_ne!(mutated, message);
        let ix = ed25519_ix(&s.eligibility, &mutated);
        let res = accept_tx(&mut s.svm, &scout, bounty_key, expires_at, ix);
        assert_named_error(res, "VerificationMessageMismatch");
    }
}

/// Cancel `bounty_id` and re-create it with `args`, in two transactions.
fn cancel_and_recreate(s: &mut Setup, bounty: Pubkey, args: CreateArgs) {
    let cancel = cancel_ix(s, s.requester.pubkey(), bounty, s.requester_ata);
    send(&mut s.svm, &s.requester, &[cancel], &[&s.requester]).unwrap();
    // An identical re-creation is byte-identical to the original funding
    // transaction; a fresh blockhash keeps litesvm from rejecting it as a
    // duplicate (as in tests 19 and 33).
    s.svm.expire_blockhash();
    let create = create_and_fund_ix_args(s, args);
    send(&mut s.svm, &s.requester, &[create], &[&s.requester]).unwrap();
}

// SPEC test 52: an unexpired voucher replayed after cancel and identical
// re-creation succeeds. This documents D86's stated limit: only the requester
// can re-create, the terms must be identical, and the voucher still attests
// only that this Scout satisfies these exact committed terms.
#[test]
fn t52_voucher_replay_after_identical_recreation_succeeds() {
    let mut s = setup();
    let bounty_id = [52u8; 16];
    let bounty_key = fund_bounty(&mut s, bounty_id);
    let scout = new_scout(&mut s);
    let expires_at = NOW + VOUCHER_TTL;
    let voucher = voucher_ix(&s.svm, &s.eligibility, &bounty_key, &scout.pubkey(), expires_at);

    cancel_and_recreate(&mut s, bounty_key, create_args(bounty_id, REWARD, 3));
    accept_tx(&mut s.svm, &scout, bounty_key, expires_at, voucher).unwrap();
    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.scout, Some(scout.pubkey()));
    assert_eq!(bounty.state, BountyState::Accepted);
}

// SPEC test 53: the same replay with policy_hash, eligibility_profile_hash or
// required_assurance changed at re-creation, three cases (D86). One fault
// each: one committed term.
#[test]
fn t53_voucher_replay_with_changed_terms_fails() {
    let cases: [(&str, fn(&mut CreateArgs)); 3] = [
        ("policy_hash", |a| a.policy_hash = [8u8; 32]),
        ("eligibility_profile_hash", |a| a.eligibility_profile_hash = [10u8; 32]),
        ("required_assurance", |a| a.required_assurance = 4),
    ];
    assert_eq!(cases.len(), 3);
    for (i, (name, change)) in cases.into_iter().enumerate() {
        eprintln!("case: {name} changed at re-creation");
        let mut s = setup();
        let bounty_id = [53u8 + i as u8; 16];
        let bounty_key = fund_bounty(&mut s, bounty_id);
        let scout = new_scout(&mut s);
        let expires_at = NOW + VOUCHER_TTL;
        let voucher =
            voucher_ix(&s.svm, &s.eligibility, &bounty_key, &scout.pubkey(), expires_at);

        let mut args = create_args(bounty_id, REWARD, 3);
        change(&mut args);
        cancel_and_recreate(&mut s, bounty_key, args);
        let res = accept_tx(&mut s.svm, &scout, bounty_key, expires_at, voucher);
        assert_named_error(res, "VerificationMessageMismatch");
    }
}

// SPEC test 54: the replay after voucher expiry (D86). One fault: the expiry;
// the clock stays inside the re-created bounty's cutoff.
#[test]
fn t54_voucher_replay_after_expiry_fails() {
    let mut s = setup();
    let bounty_id = [54u8; 16];
    let bounty_key = fund_bounty(&mut s, bounty_id);
    let scout = new_scout(&mut s);
    let expires_at = NOW + 100;
    let voucher = voucher_ix(&s.svm, &s.eligibility, &bounty_key, &scout.pubkey(), expires_at);

    cancel_and_recreate(&mut s, bounty_key, create_args(bounty_id, REWARD, 3));
    set_clock(&mut s.svm, expires_at + 1);
    let res = accept_tx(&mut s.svm, &scout, bounty_key, expires_at, voucher);
    assert_named_error(res, "VoucherExpired");
}

// SPEC test 55: accept through CPI. The test-only caller forwards the exact
// accept instruction; the Scout signs the outer transaction and `invoke`
// forwards the signer flag. One fault: the stack height (D71).
#[test]
fn t55_accept_through_cpi_fails() {
    let mut s = setup();
    s.svm.add_program(CPI_CALLER_ID, CPI_CALLER_BYTES).unwrap();
    let bounty_key = fund_bounty(&mut s, [55u8; 16]);
    let scout = new_scout(&mut s);
    let expires_at = NOW + VOUCHER_TTL;
    let voucher = voucher_ix(&s.svm, &s.eligibility, &bounty_key, &scout.pubkey(), expires_at);
    let inner = accept_ix(scout.pubkey(), bounty_key, expires_at, 0);

    let res = send(&mut s.svm, &scout, &[voucher, via_cpi(inner)], &[&scout]);
    assert_named_error(res, "InvocationNotTopLevel");
}

// ---------------------------------------------------------------------------
// SPEC 12.5 and 12.6: submit_attestation and designated verification
// (D71, D77, D82, D85, D89)
// ---------------------------------------------------------------------------

const EVIDENCE_ROOT_T: [u8; 32] = [0x0e; 32];
/// Equal to the funded requirement, 3.
const ACHIEVED: u8 = 3;
const ISSUED_AT: i64 = NOW - 60;
/// The compute-budget program: the literal of solana-sdk-ids 3.1.0
/// `compute_budget`, re-exported by solana-compute-budget-interface 3.1.0 and
/// not by anchor-lang.
const COMPUTE_BUDGET_ID: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");
/// Section 6.1 offsets, restated for the variant builders (SPEC section 9).
const KEY_OFF: usize = 16;
const SIG_OFF: usize = 48;
const MSG_OFF: usize = 112;

/// Test-side `BOUNTYCAM_ATTESTATION_V1`, placed by the published layout
/// table. `scout` and `deadline` are explicit so a message can be built for
/// a bounty that was never accepted (test 67).
fn attestation_message_with(
    bounty: &Bounty,
    scout: &Pubkey,
    deadline: i64,
    evidence_root: &[u8; 32],
    achieved: u8,
    issued_at: i64,
) -> Vec<u8> {
    let (fields, total) = layout("BOUNTYCAM_ATTESTATION_V1");
    let mut out = vec![0u8; total];
    for (name, offset, width) in &fields {
        let bytes: Vec<u8> = match name.as_str() {
            "domain_tag" => b"BOUNTYCAM_ATTESTATION_V1".to_vec(),
            "schema_version" => 1u16.to_le_bytes().to_vec(),
            "deployment_id" => vec![DEPLOYMENT_ID],
            "program_id" => escrow::id().to_bytes().to_vec(),
            "bounty_id" => bounty.bounty_id.to_vec(),
            "requester" => bounty.requester.to_bytes().to_vec(),
            "scout" => scout.to_bytes().to_vec(),
            "policy_hash" => bounty.policy_hash.to_vec(),
            "eligibility_profile_hash" => bounty.eligibility_profile_hash.to_vec(),
            "required_assurance" => vec![bounty.required_assurance],
            "deadline" => deadline.to_le_bytes().to_vec(),
            "review_window_secs" => bounty.review_window_secs.to_le_bytes().to_vec(),
            "evidence_root" => evidence_root.to_vec(),
            "achieved_assurance" => vec![achieved],
            "issued_at" => issued_at.to_le_bytes().to_vec(),
            other => panic!("unknown attestation field {other}"),
        };
        assert_eq!(bytes.len(), *width, "{name}");
        out[*offset..*offset + *width].copy_from_slice(&bytes);
    }
    out
}

/// The attestation for an accepted bounty: Scout and deadline from state.
fn attestation_message(
    bounty: &Bounty,
    evidence_root: &[u8; 32],
    achieved: u8,
    issued_at: i64,
) -> Vec<u8> {
    let scout = bounty.scout.expect("accepted bounty has a scout");
    let deadline = bounty.deadline.expect("accepted bounty has a deadline");
    attestation_message_with(bounty, &scout, deadline, evidence_root, achieved, issued_at)
}

fn attestation_ix(
    svm: &LiteSVM,
    signer: &Keypair,
    bounty: &Pubkey,
    evidence_root: &[u8; 32],
    achieved: u8,
    issued_at: i64,
) -> Instruction {
    let state = read_bounty(svm, bounty);
    ed25519_ix(signer, &attestation_message(&state, evidence_root, achieved, issued_at))
}

fn default_attestation_ix(s: &Setup, bounty: &Pubkey) -> Instruction {
    attestation_ix(&s.svm, &s.attester, bounty, &EVIDENCE_ROOT_T, ACHIEVED, ISSUED_AT)
}

fn submit_ix_with_sysvar(
    bounty: Pubkey,
    evidence_root: [u8; 32],
    achieved_assurance: u8,
    issued_at: i64,
    index: u16,
    instructions_sysvar: Pubkey,
) -> Instruction {
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::SubmitAttestation {
            evidence_root,
            achieved_assurance,
            issued_at,
            verification_instruction_index: index,
        }
        .data(),
        escrow::accounts::SubmitAttestation {
            config: config_pda(),
            bounty,
            instructions_sysvar,
        }
        .to_account_metas(None),
    )
}

fn submit_ix(
    bounty: Pubkey,
    evidence_root: [u8; 32],
    achieved_assurance: u8,
    issued_at: i64,
    index: u16,
) -> Instruction {
    let sysvar = solana_instructions_sysvar::ID;
    submit_ix_with_sysvar(bounty, evidence_root, achieved_assurance, issued_at, index, sysvar)
}

fn default_submit_ix(bounty: Pubkey, index: u16) -> Instruction {
    submit_ix(bounty, EVIDENCE_ROOT_T, ACHIEVED, ISSUED_AT, index)
}

/// Fund and accept: the state every submit test starts from.
fn accepted_bounty(s: &mut Setup, bounty_id: [u8; 16]) -> (Pubkey, Keypair) {
    let bounty = fund_bounty(s, bounty_id);
    let scout = new_scout(s);
    accept_with_voucher(s, &scout, bounty, NOW + VOUCHER_TTL).unwrap();
    (bounty, scout)
}

/// Sends `ixs` with a fresh wallet as payer and only signer: the relayer of
/// D85, which is any fee payer. No Scout signature anywhere.
fn send_relayed(
    s: &mut Setup,
    ixs: &[Instruction],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let relayer = new_scout(s);
    send(&mut s.svm, &relayer, ixs, &[&relayer])
}

/// The default submission: `[attestation, submit(index 0)]`, relayed.
fn submit_default(
    s: &mut Setup,
    bounty: Pubkey,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let attestation = default_attestation_ix(s, &bounty);
    send_relayed(s, &[attestation, default_submit_ix(bounty, 0)])
}

/// A submission whose attested level is `achieved`, validly signed.
fn submit_with_achieved(
    s: &mut Setup,
    bounty: Pubkey,
    achieved: u8,
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let attestation =
        attestation_ix(&s.svm, &s.attester, &bounty, &EVIDENCE_ROOT_T, achieved, ISSUED_AT);
    let submit = submit_ix(bounty, EVIDENCE_ROOT_T, achieved, ISSUED_AT, 0);
    send_relayed(s, &[attestation, submit])
}

/// `SetComputeUnitLimit`: discriminator 2, then the u32 little-endian
/// (solana-compute-budget-interface 3.1.0 `to_instruction!`). No accounts.
fn cb_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend(units.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET_ID,
        accounts: vec![],
        data,
    }
}

/// `SetComputeUnitPrice`: discriminator 3, then the u64 little-endian.
fn cb_price(micro_lamports: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend(micro_lamports.to_le_bytes());
    Instruction {
        program_id: COMPUTE_BUDGET_ID,
        accounts: vec![],
        data,
    }
}

fn put_u16(data: &mut [u8], at: usize, value: u16) {
    data[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

#[derive(Clone, Copy)]
enum Part {
    Key,
    Sig,
    Msg,
}

/// `base` with its key, signature and message re-laid in `order` and the
/// three offset fields rewritten to match. Header fields other than the
/// offsets, and the total length, are unchanged, so the offsets are the only
/// deviation from section 6.1.
fn relaid(base: &Instruction, order: [Part; 3]) -> Instruction {
    let key = &base.data[KEY_OFF..SIG_OFF];
    let sig = &base.data[SIG_OFF..MSG_OFF];
    let msg = &base.data[MSG_OFF..];
    let mut data = base.data[..16].to_vec();
    for part in order {
        let (bytes, field_at) = match part {
            Part::Key => (key, 6),
            Part::Sig => (sig, 2),
            Part::Msg => (msg, 10),
        };
        let at = data.len() as u16;
        put_u16(&mut data, field_at, at);
        data.extend_from_slice(bytes);
    }
    assert_eq!(data.len(), base.data.len());
    Instruction {
        data,
        ..base.clone()
    }
}

/// Like `assert_named_error`, and also pins the failing top-level
/// instruction index. Used where the designated instruction is malformed
/// for the program but valid for the native verifier: the failure must come
/// from the escrow instruction, which shows the native verifier accepted the
/// form.
#[track_caller]
fn assert_named_error_at_index(
    res: Result<TransactionMetadata, FailedTransactionMetadata>,
    name: &str,
    index: u8,
) {
    let failed = match res {
        Ok(meta) => panic!(
            "expected {name} at instruction {index}, but succeeded: {:?}",
            meta.logs
        ),
        Err(failed) => failed,
    };
    let logs = failed.meta.logs.join("\n");
    assert!(
        logs.contains(&format!("Error Code: {name}")),
        "expected named error {name}; got err {:?} with logs:\n{logs}",
        failed.err,
    );
    let err = format!("{:?}", failed.err);
    assert!(
        err.starts_with(&format!("InstructionError({index}, ")),
        "expected the failure at instruction {index}; got {err}"
    );
    eprintln!("{name} at instruction {index}: {err}");
}

// SPEC test 32: cancel after a real submit_attestation. One fault: the
// state. Guard of the existing state constraint.
#[test]
fn t32_cancel_when_submitted_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [32u8; 16]);
    submit_default(&mut s, bounty).unwrap();

    let ix = cancel_ix(&s, s.requester.pubkey(), bounty, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "BountyNotCancellable");
}

// SPEC test 56: submitted by an arbitrary fee payer with no Scout signature;
// fields written; submitted_at equals the clock; state Submitted; the
// accept-written fields and every fixed field unchanged; no token movement.
#[test]
fn t56_submit_attestation_succeeds() {
    let mut s = setup();
    let (bounty, scout) = accepted_bounty(&mut s, [56u8; 16]);
    let before = read_bounty(&s.svm, &bounty);
    let vault = associated_token::get_associated_token_address(&bounty, &s.usdc_mint);

    submit_default(&mut s, bounty).unwrap();

    let after = read_bounty(&s.svm, &bounty);
    assert_eq!(after.evidence_root, Some(EVIDENCE_ROOT_T));
    assert_eq!(after.achieved_assurance, Some(ACHIEVED));
    assert_eq!(after.submitted_at, Some(NOW));
    assert_eq!(after.state, BountyState::Submitted);
    assert_eq!(after.scout, Some(scout.pubkey()));
    assert_eq!(after.deadline, before.deadline);
    assert_fixed_fields_equal(&before, &after);
    assert_eq!(token_balance(&s.svm, &vault), REWARD);
    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE - REWARD);
}

// SPEC test 57: at exactly deadline succeeds (D81).
#[test]
fn t57_submit_at_exactly_deadline_succeeds() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [57u8; 16]);
    let deadline = read_bounty(&s.svm, &bounty).deadline.unwrap();
    set_clock(&mut s.svm, deadline);

    submit_default(&mut s, bounty).unwrap();
    let after = read_bounty(&s.svm, &bounty);
    assert_eq!(after.state, BountyState::Submitted);
    assert_eq!(after.submitted_at, Some(deadline));
}

// SPEC test 58: one second after deadline. One fault: the clock.
#[test]
fn t58_submit_one_second_after_deadline_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [58u8; 16]);
    let deadline = read_bounty(&s.svm, &bounty).deadline.unwrap();
    set_clock(&mut s.svm, deadline + 1);

    let res = submit_default(&mut s, bounty);
    assert_named_error(res, "SubmissionDeadlinePassed");
}

// SPEC test 59: achieved below required, validly signed. One fault: the
// attested level. The bounty account is byte-identical afterwards (D85).
#[test]
fn t59_submit_with_achieved_below_required_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [59u8; 16]);
    let snapshot = s.svm.get_account(&bounty).unwrap().data;

    let res = submit_with_achieved(&mut s, bounty, 2);
    assert_named_error(res, "InsufficientAssurance");
    assert_eq!(s.svm.get_account(&bounty).unwrap().data, snapshot, "byte-identical");
}

// SPEC test 60: achieved equal to required succeeds.
#[test]
fn t60_submit_with_achieved_equal_to_required_succeeds() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [60u8; 16]);
    submit_with_achieved(&mut s, bounty, 3).unwrap();
    assert_eq!(read_bounty(&s.svm, &bounty).achieved_assurance, Some(3));
}

// SPEC test 61: achieved above required succeeds.
#[test]
fn t61_submit_with_achieved_above_required_succeeds() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [61u8; 16]);
    submit_with_achieved(&mut s, bounty, 4).unwrap();
    assert_eq!(read_bounty(&s.svm, &bounty).achieved_assurance, Some(4));
}

// SPEC test 62: achieved 5, validly signed. One fault: the range; check 6
// precedes check 7.
#[test]
fn t62_submit_with_achieved_above_max_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [62u8; 16]);
    let res = submit_with_achieved(&mut s, bounty, 5);
    assert_named_error(res, "AchievedAssuranceOutOfRange");
}

// SPEC test 63: an attestation naming another Scout, signed by the attester.
// One fault: the Scout; the reconstruction uses the stored one (D85).
#[test]
fn t63_attestation_naming_other_scout_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [63u8; 16]);
    let state = read_bounty(&s.svm, &bounty);
    let other = Pubkey::new_unique();
    let message = attestation_message_with(
        &state,
        &other,
        state.deadline.unwrap(),
        &EVIDENCE_ROOT_T,
        ACHIEVED,
        ISSUED_AT,
    );
    let ix = ed25519_ix(&s.attester, &message);

    let res = send_relayed(&mut s, &[ix, default_submit_ix(bounty, 0)]);
    assert_named_error(res, "VerificationMessageMismatch");
}

// SPEC test 64: the correct attestation signed by the eligibility key, the
// arbiter and a fresh key, three cases. One fault: the verifying key.
#[test]
fn t64_attestation_signed_by_non_attester_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [64u8; 16]);
    let state = read_bounty(&s.svm, &bounty);
    let message = attestation_message(&state, &EVIDENCE_ROOT_T, ACHIEVED, ISSUED_AT);

    let signers: [(&str, Keypair); 3] = [
        ("eligibility", s.eligibility.insecure_clone()),
        ("arbiter", s.arbiter.insecure_clone()),
        ("fresh key", Keypair::new()),
    ];
    assert_eq!(signers.len(), 3);
    for (name, signer) in &signers {
        eprintln!("case: signed by the {name}");
        let ix = ed25519_ix(signer, &message);
        let res = send_relayed(&mut s, &[ix, default_submit_ix(bounty, 0)]);
        assert_named_error(res, "VerificationAuthorityMismatch");
    }
}

// SPEC test 65: the fifteen published attestation mutation vectors, each.
// A published vector carries fixed requester, Scout and program bytes no live
// bounty can match without planting, so each mutation is consumed as a byte
// delta against the published nominal message and replayed onto the live
// message. Before any case runs: 15 entries; their fields equal the
// published table's 15 names in order; each differs from the nominal message
// only inside its field's offset range.
#[test]
fn t65_published_attestation_mutations_fail() {
    let doc: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
    let mutations = doc["mutations_attestation"].as_array().unwrap();
    assert_eq!(mutations.len(), 15, "MESSAGES.md section 8: 15 mutation vectors");
    let (fields, _) = layout("BOUNTYCAM_ATTESTATION_V1");
    assert_eq!(fields.len(), 15);
    let names: Vec<&str> = mutations.iter().map(|m| m["field"].as_str().unwrap()).collect();
    let table_names: Vec<&str> = fields.iter().map(|f| f.0.as_str()).collect();
    assert_eq!(names, table_names, "mutation fields equal the layout table's fields");
    assert_eq!(doc["vectors"][0]["name"], "ATT-01");
    let nominal = hex(doc["vectors"][0]["message_hex"].as_str().unwrap());

    let mut deltas: Vec<(String, Vec<u8>)> = Vec::new();
    for (m, (name, offset, width)) in mutations.iter().zip(&fields) {
        let mutated = hex(m["message_hex"].as_str().unwrap());
        assert_eq!(mutated.len(), nominal.len(), "{name}");
        assert_ne!(mutated, nominal, "{name}: mutation differs from the nominal message");
        assert_eq!(m["offset"].as_u64().unwrap() as usize, *offset, "{name}");
        assert_eq!(m["width"].as_u64().unwrap() as usize, *width, "{name}");
        let delta: Vec<u8> = nominal.iter().zip(&mutated).map(|(a, b)| a ^ b).collect();
        assert!(delta.iter().any(|b| *b != 0), "{name}: non-empty delta");
        for (i, b) in delta.iter().enumerate() {
            if *b != 0 {
                assert!(
                    (*offset..offset + width).contains(&i),
                    "{name}: delta byte {i} outside the field"
                );
            }
        }
        deltas.push((name.clone(), delta));
    }
    assert_eq!(deltas.len(), 15);

    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [65u8; 16]);
    let state = read_bounty(&s.svm, &bounty);
    let live = attestation_message(&state, &EVIDENCE_ROOT_T, ACHIEVED, ISSUED_AT);
    for (name, delta) in &deltas {
        eprintln!("case: {name}");
        let mutated: Vec<u8> = live.iter().zip(delta).map(|(a, b)| a ^ b).collect();
        assert_ne!(mutated, live);
        let ix = ed25519_ix(&s.attester, &mutated);
        let res = send_relayed(&mut s, &[ix, default_submit_ix(bounty, 0)]);
        assert_named_error(res, "VerificationMessageMismatch");
    }
}

// SPEC test 66: a second submission of the same attestation. One fault: the
// state is Submitted. The same two instructions are sent twice.
#[test]
fn t66_second_submission_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [66u8; 16]);
    let ixs = [default_attestation_ix(&s, &bounty), default_submit_ix(bounty, 0)];
    send_relayed(&mut s, &ixs).unwrap();

    s.svm.expire_blockhash();
    let res = send_relayed(&mut s, &ixs);
    assert_named_error(res, "BountyNotAttestable");
}

// SPEC test 67: before accept. One fault: the state is Funded. The
// attestation is well-formed and attester-signed, with an explicit Scout and
// deadline because the account holds neither.
#[test]
fn t67_submit_before_accept_fails() {
    let mut s = setup();
    let bounty = fund_bounty(&mut s, [67u8; 16]);
    let state = read_bounty(&s.svm, &bounty);
    let message = attestation_message_with(
        &state,
        &Pubkey::new_unique(),
        NOW + COMPLETION_WINDOW,
        &EVIDENCE_ROOT_T,
        ACHIEVED,
        ISSUED_AT,
    );
    let ix = ed25519_ix(&s.attester, &message);

    let res = send_relayed(&mut s, &[ix, default_submit_ix(bounty, 0)]);
    assert_named_error(res, "BountyNotAttestable");
}

// SPEC test 68: a valid attestation for another bounty. One fault: the
// bounty. Both bounties are accepted; A's attestation is submitted against B.
#[test]
fn t68_attestation_for_other_bounty_fails() {
    let mut s = setup();
    let (a, _) = accepted_bounty(&mut s, [68u8; 16]);
    let (b, _) = accepted_bounty(&mut s, [69u8; 16]);
    let attestation_for_a = default_attestation_ix(&s, &a);

    let res = send_relayed(&mut s, &[attestation_for_a, default_submit_ix(b, 0)]);
    assert_named_error(res, "VerificationMessageMismatch");
}

// SPEC test 69: submit_attestation through CPI. One fault: the stack height.
#[test]
fn t69_submit_through_cpi_fails() {
    let mut s = setup();
    s.svm.add_program(CPI_CALLER_ID, CPI_CALLER_BYTES).unwrap();
    let (bounty, _scout) = accepted_bounty(&mut s, [70u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let inner = default_submit_ix(bounty, 0);

    let res = send_relayed(&mut s, &[attestation, via_cpi(inner)]);
    assert_named_error(res, "InvocationNotTopLevel");
}

// SPEC test 70: a fake account as the Instructions sysvar. One fault: the
// sysvar address.
#[test]
fn t70_fake_instructions_sysvar_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [71u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let fake = Pubkey::new_unique();
    let submit =
        submit_ix_with_sysvar(bounty, EVIDENCE_ROOT_T, ACHIEVED, ISSUED_AT, 0, fake);

    let res = send_relayed(&mut s, &[attestation, submit]);
    assert_named_error(res, "InvalidInstructionsSysvar");
}

// SPEC test 71: index equal to the current instruction.
#[test]
fn t71_index_equal_to_current_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [72u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let res = send_relayed(&mut s, &[attestation, default_submit_ix(bounty, 1)]);
    assert_named_error(res, "VerificationIndexInvalid");
}

// SPEC test 72: index after the current instruction, at a valid ed25519
// instruction that has not yet run.
#[test]
fn t72_index_after_current_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [73u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let ixs = [attestation.clone(), default_submit_ix(bounty, 2), attestation];
    let res = send_relayed(&mut s, &ixs);
    assert_named_error(res, "VerificationIndexInvalid");
}

// SPEC test 73: index beyond the instruction count.
#[test]
fn t73_index_beyond_count_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [74u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let res = send_relayed(&mut s, &[attestation, default_submit_ix(bounty, 7)]);
    assert_named_error(res, "VerificationIndexInvalid");
}

// SPEC test 74: index at a compute-budget instruction. The real attestation
// sits at index 1; the designated index 0 is the compute-budget instruction.
#[test]
fn t74_index_at_compute_budget_instruction_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [75u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let ixs = [cb_limit(400_000), attestation, default_submit_ix(bounty, 0)];
    let res = send_relayed(&mut s, &ixs);
    assert_named_error(res, "NotEd25519Instruction");
}

// SPEC test 75: the two-byte zero-signature instruction, which the native
// verifier accepts (agave-precompiles 3.1.14 ed25519.rs lines 16 to 22).
// One fault: the shape. The failure index 1 is the escrow instruction.
#[test]
fn t75_zero_signature_instruction_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [76u8; 16]);
    let base = default_attestation_ix(&s, &bounty);
    let variant = Instruction {
        data: vec![0, 0],
        accounts: vec![],
        ..base
    };
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
}

// SPEC test 76: a valid two-signature instruction: count 2, two identical
// offset structures each raised by 14 to skip the second header entry, then
// the same key, signature and message. The native verifier checks both.
#[test]
fn t76_two_signature_instruction_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [77u8; 16]);
    let base = default_attestation_ix(&s, &bounty);
    let mut offsets = base.data[2..16].to_vec();
    for at in [0, 4, 8] {
        let value = u16::from_le_bytes([offsets[at], offsets[at + 1]]) + 14;
        put_u16(&mut offsets, at, value);
    }
    let mut data = vec![2u8, 0];
    data.extend(&offsets);
    data.extend(&offsets);
    data.extend(&base.data[16..]);
    let variant = Instruction { data, ..base };
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
}

// SPEC test 77: padding byte non-zero, which the native verifier never reads
// (ed25519.rs line 26).
#[test]
fn t77_non_zero_padding_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [78u8; 16]);
    let mut variant = default_attestation_ix(&s, &bounty);
    variant.data[1] = 1;
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
}

// SPEC test 78: each of the three instruction-index fields pointed at
// instruction 0, a valid copy holding the same bytes at the same offsets,
// three cases. The designated instruction is index 1; the escrow is index 2.
#[test]
fn t78_index_fields_pointing_elsewhere_fail() {
    let cases: [(&str, usize); 3] = [
        ("signature instruction index", 4),
        ("public key instruction index", 8),
        ("message instruction index", 14),
    ];
    assert_eq!(cases.len(), 3);
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [79u8; 16]);
    let base = default_attestation_ix(&s, &bounty);
    for (name, at) in cases {
        eprintln!("case: {name} at bytes {at} to {}", at + 1);
        let mut variant = base.clone();
        put_u16(&mut variant.data, at, 0);
        let ixs = [base.clone(), variant, default_submit_ix(bounty, 1)];
        let res = send_relayed(&mut s, &ixs);
        assert_named_error_at_index(res, "MalformedVerificationInstruction", 2);
    }
}

// SPEC test 79: key, signature and message moved to a valid alternative
// layout, three cases: each is a permutation with the offsets rewritten and
// the total length unchanged, so the offsets are the only deviation.
#[test]
fn t79_alternative_layouts_fail() {
    let cases: [(&str, [Part; 3]); 3] = [
        ("signature first", [Part::Sig, Part::Key, Part::Msg]),
        ("message first", [Part::Msg, Part::Key, Part::Sig]),
        ("key, message, signature", [Part::Key, Part::Msg, Part::Sig]),
    ];
    assert_eq!(cases.len(), 3);
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [80u8; 16]);
    let base = default_attestation_ix(&s, &bounty);
    for (name, order) in cases {
        eprintln!("case: {name}");
        let variant = relaid(&base, order);
        let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
        assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
    }
}

// SPEC test 80: the message size field one short. The signature is made
// over the shorter message so the native verifier accepts it; the final
// message byte is still present, so the total length is canonical.
#[test]
fn t80_wrong_message_size_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [81u8; 16]);
    let base = default_attestation_ix(&s, &bounty);
    let message = attestation_message(
        &read_bounty(&s.svm, &bounty),
        &EVIDENCE_ROOT_T,
        ACHIEVED,
        ISSUED_AT,
    );
    let mut variant = ed25519_ix(&s.attester, &message[..message.len() - 1]);
    variant.data.push(message[message.len() - 1]);
    assert_eq!(variant.data.len(), base.data.len());
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
}

// SPEC test 81: trailing bytes after the message, which the native verifier
// accepts (ed25519.rs line 27 is a lower bound only).
#[test]
fn t81_trailing_bytes_fail() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [82u8; 16]);
    let mut variant = default_attestation_ix(&s, &bounty);
    variant.data.push(0);
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
}

// SPEC test 82: truncated offsets. The data ends inside the 14-byte offset
// structure, so the native verifier rejects it (ed25519.rs line 27,
// InvalidInstructionDataSize) at the designated index 0 and the program
// never runs. Guard: the check is outside the program (D89). A precompile
// error reaches litesvm as InstructionError(index, Custom(variant)), variant
// 4 being InvalidInstructionDataSize in solana-precompile-error 3.0.0.
#[test]
fn t82_truncated_offsets_fail_in_native_verifier() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [83u8; 16]);
    let mut variant = default_attestation_ix(&s, &bounty);
    variant.data.truncate(10);
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    let failed = res.expect_err("expected the native verifier to reject the truncated data");
    let err = format!("{:?}", failed.err);
    assert_eq!(err, "InstructionError(0, Custom(4))");
    let logs = failed.meta.logs.join("\n");
    assert!(!logs.contains("Instruction: SubmitAttestation"), "program ran:\n{logs}");
    eprintln!(
        "native verifier rejected the designated instruction at index 0 with \
         InvalidInstructionDataSize (Custom(4)); the program did not run"
    );
}

// SPEC test 83: the designated instruction carrying one account, which the
// native verifier ignores.
#[test]
fn t83_designated_instruction_with_account_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [84u8; 16]);
    let mut variant = default_attestation_ix(&s, &bounty);
    variant.accounts = vec![AccountMeta::new_readonly(config_pda(), false)];
    let res = send_relayed(&mut s, &[variant, default_submit_ix(bounty, 0)]);
    assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
}

// SPEC test 84: a valid attester signature over a different message of the
// right length. One fault: the content.
#[test]
fn t84_valid_signature_over_other_message_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [85u8; 16]);
    let other = ed25519_ix(&s.attester, &[0xab; 261]);
    let res = send_relayed(&mut s, &[other, default_submit_ix(bounty, 0)]);
    assert_named_error(res, "VerificationMessageMismatch");
}

// SPEC test 85: a voucher on the attestation path and an attestation on the
// accept path, two cases, each signed by that path's expected authority so
// the message type is the only fault; rejected by length (212 against 261)
// before any authority or content comparison. The failure index 1 is the
// escrow instruction on both paths.
#[test]
fn t85_cross_type_messages_fail() {
    let cases: [&str; 2] = [
        "voucher on the attestation path",
        "attestation on the accept path",
    ];
    assert_eq!(cases.len(), 2);
    let mut s = setup();
    for name in cases {
        eprintln!("case: {name}");
        let res = match name {
            "voucher on the attestation path" => {
                let (bounty, scout) = accepted_bounty(&mut s, [86u8; 16]);
                let state = read_bounty(&s.svm, &bounty);
                let voucher = eligibility_message(&state, &scout.pubkey(), NOW + VOUCHER_TTL);
                let ix = ed25519_ix(&s.attester, &voucher);
                send_relayed(&mut s, &[ix, default_submit_ix(bounty, 0)])
            }
            "attestation on the accept path" => {
                let bounty = fund_bounty(&mut s, [87u8; 16]);
                let scout = new_scout(&mut s);
                let state = read_bounty(&s.svm, &bounty);
                let attestation = attestation_message_with(
                    &state,
                    &scout.pubkey(),
                    NOW + COMPLETION_WINDOW,
                    &EVIDENCE_ROOT_T,
                    ACHIEVED,
                    ISSUED_AT,
                );
                let ix = ed25519_ix(&s.eligibility, &attestation);
                accept_tx(&mut s.svm, &scout, bounty, NOW + VOUCHER_TTL, ix)
            }
            other => panic!("unknown case {other}"),
        };
        assert_named_error_at_index(res, "MalformedVerificationInstruction", 1);
    }
}

// SPEC test 86: two identical valid ed25519 instructions, the first
// designated, succeeds.
#[test]
fn t86_duplicate_verification_first_designated_succeeds() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [88u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let ixs = [attestation.clone(), attestation, default_submit_ix(bounty, 0)];
    send_relayed(&mut s, &ixs).unwrap();
    assert_eq!(read_bounty(&s.svm, &bounty).state, BountyState::Submitted);
}

// SPEC test 87: the same, the second designated, succeeds.
#[test]
fn t87_duplicate_verification_second_designated_succeeds() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [89u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let ixs = [attestation.clone(), attestation, default_submit_ix(bounty, 1)];
    send_relayed(&mut s, &ixs).unwrap();
    assert_eq!(read_bounty(&s.svm, &bounty).state, BountyState::Submitted);
}

// SPEC test 88: a valid matching ed25519 instruction elsewhere while the
// designated one, signed by the attester over other bytes of the right
// length, does not match. Only the designated instruction binds (D71).
#[test]
fn t88_matching_verification_elsewhere_fails() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [90u8; 16]);
    let designated = ed25519_ix(&s.attester, &[0xab; 261]);
    let matching = default_attestation_ix(&s, &bounty);
    let ixs = [designated, matching, default_submit_ix(bounty, 0)];
    let res = send_relayed(&mut s, &ixs);
    assert_named_error(res, "VerificationMessageMismatch");
}

// SPEC test 89: compute-budget instructions between the verification and the
// program instruction succeed; adjacency is not required (D71).
#[test]
fn t89_compute_budget_between_succeeds() {
    let mut s = setup();
    let (bounty, _scout) = accepted_bounty(&mut s, [95u8; 16]);
    let attestation = default_attestation_ix(&s, &bounty);
    let ixs = [attestation, cb_limit(400_000), cb_price(1), default_submit_ix(bounty, 0)];
    send_relayed(&mut s, &ixs).unwrap();
    assert_eq!(read_bounty(&s.svm, &bounty).state, BountyState::Submitted);
}
