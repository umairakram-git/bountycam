use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::Instruction, program_pack::Pack, system_instruction, system_program,
        },
        AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{self, spl_associated_token_account},
        token::spl_token,
    },
    escrow::{
        constants::BOUNTY_SEED,
        state::{Bounty, BountyState},
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
const REVIEW_WINDOW: i64 = 3_600;

struct Setup {
    svm: LiteSVM,
    requester: Keypair,
    usdc_mint: Pubkey,
    requester_ata: Pubkey,
    attester: Pubkey,
    arbiter: Pubkey,
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

fn setup() -> Setup {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/escrow.so"));
    svm.add_program(escrow::id(), bytes).unwrap();

    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = NOW;
    svm.set_sysvar::<Clock>(&clock);

    let requester = Keypair::new();
    svm.airdrop(&requester.pubkey(), 10_000_000_000).unwrap();

    let usdc_mint = create_mint(&mut svm, &requester);
    let requester_ata =
        create_funded_ata(&mut svm, &requester, &requester.pubkey(), &usdc_mint, INITIAL_BALANCE);

    Setup {
        svm,
        requester,
        usdc_mint,
        requester_ata,
        attester: Pubkey::new_unique(),
        arbiter: Pubkey::new_unique(),
    }
}

fn bounty_pda(requester: &Pubkey, bounty_id: &[u8; 16]) -> Pubkey {
    Pubkey::find_program_address(
        &[BOUNTY_SEED, requester.as_ref(), bounty_id.as_ref()],
        &escrow::id(),
    )
    .0
}

#[allow(clippy::too_many_arguments)]
fn create_and_fund_ix(
    s: &Setup,
    bounty_id: [u8; 16],
    reward_amount: u64,
    required_assurance: u8,
    deadline: i64,
    requester_ata: Pubkey,
) -> Instruction {
    let requester = s.requester.pubkey();
    let bounty = bounty_pda(&requester, &bounty_id);
    let bounty_vault = associated_token::get_associated_token_address(&bounty, &s.usdc_mint);
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::CreateAndFund {
            bounty_id,
            reward_amount,
            policy_hash: POLICY_HASH,
            required_assurance,
            attester_authority: s.attester,
            deadline,
            review_window_secs: REVIEW_WINDOW,
        }
        .data(),
        escrow::accounts::CreateAndFund {
            requester,
            bounty,
            usdc_mint: s.usdc_mint,
            bounty_vault,
            requester_ata,
            arbiter_authority: s.arbiter,
            token_program: spl_token::id(),
            associated_token_program: associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn cancel_ix(s: &Setup, signer: Pubkey, bounty: Pubkey, requester_ata: Pubkey) -> Instruction {
    let bounty_vault = associated_token::get_associated_token_address(&bounty, &s.usdc_mint);
    Instruction::new_with_bytes(
        escrow::id(),
        &escrow::instruction::Cancel {}.data(),
        escrow::accounts::Cancel {
            requester: signer,
            bounty,
            usdc_mint: s.usdc_mint,
            bounty_vault,
            requester_ata,
            token_program: spl_token::id(),
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

// SPEC test 12 (fee assertions per D67; the section 4.1 field set lands in
// commit 6).
#[test]
fn t12_create_and_fund_succeeds() {
    let mut s = setup();
    let bounty_id = [1u8; 16];
    let deadline = NOW + 86_400;
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, deadline, s.requester_ata);
    let requester = s.requester.pubkey();
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let bounty_key = bounty_pda(&requester, &bounty_id);
    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.bounty_id, bounty_id);
    assert_eq!(bounty.requester, requester);
    assert_eq!(bounty.scout, None);
    assert_eq!(bounty.usdc_mint, s.usdc_mint);
    assert_eq!(bounty.reward_amount, REWARD);
    assert_eq!(bounty.platform_fee, 0);
    assert_eq!(bounty.policy_hash, POLICY_HASH);
    assert_eq!(bounty.required_assurance, 3);
    assert_eq!(bounty.attester_authority, s.attester);
    assert_eq!(bounty.arbiter_authority, s.arbiter);
    assert_eq!(bounty.deadline, deadline);
    assert_eq!(bounty.review_window_secs, REVIEW_WINDOW);
    assert_eq!(bounty.submitted_at, None);
    assert_eq!(bounty.merkle_root, None);
    assert_eq!(bounty.achieved_assurance, None);
    assert_eq!(bounty.state, BountyState::Funded);

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
    let ix = create_and_fund_ix(&s, bounty_id, u64::MAX, 3, NOW + 86_400, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let bounty_key = bounty_pda(&s.requester.pubkey(), &bounty_id);
    let bounty = read_bounty(&s.svm, &bounty_key);
    assert_eq!(bounty.reward_amount, u64::MAX);
    assert_eq!(bounty.platform_fee, 0);
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);
    assert_eq!(token_balance(&s.svm, &vault), u64::MAX);
    assert_eq!(token_balance(&s.svm, &s.requester_ata), 0);
}

#[test]
fn cancel_succeeds() {
    let mut s = setup();
    let bounty_id = [2u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, NOW + 86_400, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    let requester = s.requester.pubkey();
    let bounty_key = bounty_pda(&requester, &bounty_id);
    let vault = associated_token::get_associated_token_address(&bounty_key, &s.usdc_mint);

    let ix = cancel_ix(&s, requester, bounty_key, s.requester_ata);
    send(&mut s.svm, &s.requester, &[ix], &[&s.requester]).unwrap();

    assert_eq!(token_balance(&s.svm, &s.requester_ata), INITIAL_BALANCE);
    assert!(s.svm.get_account(&vault).is_none_or(|a| a.lamports == 0));
    assert!(s
        .svm
        .get_account(&bounty_key)
        .is_none_or(|a| a.lamports == 0));
}

#[test]
fn cancel_by_non_requester_fails() {
    let mut s = setup();
    let bounty_id = [3u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, NOW + 86_400, s.requester_ata);
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
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, NOW + 86_400, s.requester_ata);
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

#[test]
fn create_with_zero_reward_fails() {
    let mut s = setup();
    let ix = create_and_fund_ix(&s, [5u8; 16], 0, 3, NOW + 86_400, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "InvalidRewardAmount");
}

#[test]
fn create_with_past_deadline_fails() {
    let mut s = setup();
    let ix = create_and_fund_ix(&s, [6u8; 16], REWARD, 3, NOW - 100, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "DeadlineInPast");
}

#[test]
fn create_with_assurance_above_max_fails() {
    let mut s = setup();
    let ix = create_and_fund_ix(&s, [7u8; 16], REWARD, 5, NOW + 86_400, s.requester_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "AssuranceTooHigh");
}

#[test]
fn create_twice_with_same_bounty_id_fails() {
    let mut s = setup();
    let bounty_id = [8u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, NOW + 86_400, s.requester_ata);
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

#[test]
fn cancel_twice_fails() {
    let mut s = setup();
    let bounty_id = [9u8; 16];
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, NOW + 86_400, s.requester_ata);
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

#[test]
fn create_with_wrong_mint_fails() {
    let mut s = setup();
    let wrong_mint = create_mint(&mut s.svm, &s.requester);
    let wrong_ata = create_funded_ata(
        &mut s.svm,
        &s.requester,
        &s.requester.pubkey(),
        &wrong_mint,
        INITIAL_BALANCE,
    );

    let ix = create_and_fund_ix(&s, [10u8; 16], REWARD, 3, NOW + 86_400, wrong_ata);
    let res = send(&mut s.svm, &s.requester, &[ix], &[&s.requester]);
    assert_named_error(res, "MintMismatch");
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

    let ix = create_and_fund_ix(&s, [22u8; 16], REWARD, 3, NOW + 86_400, mallory_ata);
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
    let ix = create_and_fund_ix(&s, bounty_id, REWARD, 3, NOW + 86_400, s.requester_ata);
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
