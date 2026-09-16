use {
    anchor_lang::{
        // base64 through anchor-lang's private re-export: acceptable because
        // anchor-lang is pinned =1.1.2, so the re-export cannot drift.
        __private::base64::{engine::general_purpose::STANDARD, Engine},
        prelude::{Clock, ProgramData, Pubkey},
        solana_program::{
            bpf_loader_upgradeable, instruction::Instruction, program_pack::Pack,
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

struct Setup {
    svm: LiteSVM,
    /// Harness upgrade authority, written into ProgramData by `set_upgrade_authority`.
    upgrade_authority: Keypair,
    requester: Keypair,
    usdc_mint: Pubkey,
    requester_ata: Pubkey,
    config: Pubkey,
    eligibility: Pubkey,
    attester: Pubkey,
    arbiter: Pubkey,
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
        eligibility: Pubkey::new_unique(),
        attester: Pubkey::new_unique(),
        arbiter: Pubkey::new_unique(),
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
        [s.eligibility, s.attester, s.arbiter],
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

// SPEC test 91: missing signer. Part 1 covers the create_and_fund requester
// and the cancel requester; part 2 adds the accept Scout as the third case.
// A relayer pays and is the only signer; the requester's meta is demoted.
#[test]
fn t91_missing_signer_fails() {
    let mut s = setup();
    let requester = s.requester.pubkey();
    let relayer = Keypair::new();
    s.svm.airdrop(&relayer.pubkey(), 1_000_000_000).unwrap();
    let funded = fund_bounty(&mut s, [91u8; 16]);

    let cases: [Instruction; 2] = [
        create_and_fund_ix(&s, [92u8; 16], REWARD, 3, s.requester_ata),
        cancel_ix(&s, requester, funded, s.requester_ata),
    ];
    assert_eq!(cases.len(), 2);
    for mut ix in cases {
        let meta = ix.accounts.iter_mut().find(|m| m.pubkey == requester).unwrap();
        assert!(meta.is_signer);
        meta.is_signer = false;
        let res = send(&mut s.svm, &relayer, &[ix], &[&relayer]);
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

#[test]
fn cancel_when_accepted_fails() {
    let mut s = setup();
    let bounty_id = [4u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    // No accept instruction exists yet, so force the state transition directly.
    let bounty_key = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let mut account = s.svm.get_account(&bounty_key).unwrap();
    let original_len = account.data.len();
    let mut bounty = Bounty::try_deserialize(&mut account.data.as_slice()).unwrap();
    bounty.state = BountyState::Accepted;
    bounty.scout = Some(Pubkey::new_unique());
    let mut data = Vec::new();
    bounty.try_serialize(&mut data).unwrap();
    data.resize(original_len, 0);
    account.data = data;
    s.svm.set_account(bounty_key, account).unwrap();

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
    assert_eq!(config.eligibility_authority, s.eligibility);
    assert_eq!(config.attester_authority, s.attester);
    assert_eq!(config.arbiter_authority, s.arbiter);
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
        [s.eligibility, s.attester, s.arbiter],
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
