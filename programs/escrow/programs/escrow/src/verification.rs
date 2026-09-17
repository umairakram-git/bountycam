//! SPEC section 6: designated ed25519 verification (D71, task 12). One
//! routine, used by `accept` and `submit_attestation`. It establishes only
//! that the designated earlier native ed25519 instruction verified exactly
//! `expected_message` under exactly `expected_authority`. It knows nothing of
//! vouchers or attestations, and it never reads the signature.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::{constants::*, error::EscrowError};

/// Section 6.1, bytes 0 to 15: the one accepted shape, with the message size
/// spliced in at bytes 12 to 13. Every value is the section 6.1 table; the
/// offsets are the section 9 constants; `u16::MAX` is "this instruction".
fn expected_header(message_len: usize) -> [u8; ED25519_HEADER_LEN] {
    let this = u16::MAX.to_le_bytes();
    let sig = (ED25519_SIGNATURE_OFFSET as u16).to_le_bytes();
    let key = (ED25519_PUBKEY_OFFSET as u16).to_le_bytes();
    let msg = (ED25519_MESSAGE_OFFSET as u16).to_le_bytes();
    let len = (message_len as u16).to_le_bytes();
    [
        1, 0, // 0: signature count 1; 1: padding 0
        sig[0], sig[1], // 2 to 3: signature offset 48
        this[0], this[1], // 4 to 5: signature instruction index
        key[0], key[1], // 6 to 7: public key offset 16
        this[0], this[1], // 8 to 9: public key instruction index
        msg[0], msg[1], // 10 to 11: message offset 112
        len[0], len[1], // 12 to 13: message size
        this[0], this[1], // 14 to 15: message instruction index
    ]
}

/// Section 6.2. Check 1, the sysvar address, is the `address` constraint on
/// the caller's account. The first failing check reports its error.
pub(crate) fn verify_ed25519_instruction(
    sysvar: &AccountInfo,
    index: u16,
    expected_authority: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    // Check 2: the current top-level index, the last two bytes of the sysvar.
    let current = load_current_index_checked(sysvar)?;
    // Check 3. Covers every out-of-range index too: `current` is itself a
    // valid index, so anything below it is in range.
    require!(index < current, EscrowError::VerificationIndexInvalid);
    let ix = load_instruction_at_checked(usize::from(index), sysvar)?;
    // Check 4.
    require_keys_eq!(
        ix.program_id,
        ED25519_PROGRAM_ID,
        EscrowError::NotEd25519Instruction
    );
    // Check 5: no accounts, exact length, then bytes 0 to 15 in one
    // comparison. The length test precedes the slice, so the slice is never
    // taken from short data.
    let expected_len = ED25519_MESSAGE_OFFSET + expected_message.len();
    require!(
        ix.accounts.is_empty()
            && ix.data.len() == expected_len
            && ix.data[..ED25519_HEADER_LEN] == expected_header(expected_message.len()),
        EscrowError::MalformedVerificationInstruction
    );
    // Check 6.
    require!(
        ix.data[ED25519_PUBKEY_OFFSET..ED25519_SIGNATURE_OFFSET] == expected_authority.to_bytes(),
        EscrowError::VerificationAuthorityMismatch
    );
    // Check 7. The signature at 48 to 111 is never read.
    require!(
        ix.data[ED25519_MESSAGE_OFFSET..] == *expected_message,
        EscrowError::VerificationMessageMismatch
    );
    Ok(())
}
