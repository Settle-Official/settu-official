//! Quote-signature check through the native Ed25519SigVerify program.
//!
//! Solana programs can't cheaply verify ed25519 themselves. Instead the client
//! puts an Ed25519SigVerify instruction IMMEDIATELY before `bridge`; the
//! runtime verifies it before any instruction runs (the whole transaction
//! fails on a bad signature), and `bridge` reads that instruction back
//! through the instructions sysvar to confirm it covered exactly the stored
//! signer key and exactly the rebuilt quote bytes.
//!
//! Instruction data layout (solana-ed25519-program 3.0.0, little-endian):
//!   [0]  num_signatures u8   [1] padding u8
//!   [2..16] Ed25519SignatureOffsets {
//!       signature_offset u16, signature_instruction_index u16,
//!       public_key_offset u16, public_key_instruction_index u16,
//!       message_data_offset u16, message_data_size u16,
//!       message_instruction_index u16 }
//!   then the referenced pubkey / signature / message bytes.
//!
//! Strict rules: exactly one signature, zero padding, and every
//! `*_instruction_index` must be u16::MAX ("this instruction"), so the data the
//! runtime verified is the data we compare. All offsets must lie inside the
//! instruction data.

use anchor_lang::prelude::*;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const HEADER_LEN: usize = 16;
const PUBKEY_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;
const THIS_INSTRUCTION: u16 = u16::MAX;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigCheckError {
    /// No Ed25519SigVerify instruction immediately before `bridge`.
    Missing,
    /// It exists but isn't a single, self-contained signature.
    Malformed,
    /// It verified a different public key than the stored signer.
    SignerMismatch,
    /// It verified a different message than this quote.
    MessageMismatch,
}

/// Pure check of one instruction (`program_id`, `data`). Host-testable.
pub fn check_ed25519_ix(
    program_id: &Pubkey,
    data: &[u8],
    expected_signer: &[u8; 32],
    expected_message: &[u8],
) -> core::result::Result<(), SigCheckError> {
    if program_id != &ED25519_PROGRAM_ID {
        return Err(SigCheckError::Missing);
    }
    if data.len() < HEADER_LEN || data[0] != 1 || data[1] != 0 {
        return Err(SigCheckError::Malformed);
    }
    let rd = |i: usize| u16::from_le_bytes([data[i], data[i + 1]]);
    let signature_offset = rd(2);
    let signature_ix = rd(4);
    let public_key_offset = rd(6);
    let public_key_ix = rd(8);
    let message_offset = rd(10);
    let message_size = rd(12);
    let message_ix = rd(14);

    if signature_ix != THIS_INSTRUCTION
        || public_key_ix != THIS_INSTRUCTION
        || message_ix != THIS_INSTRUCTION
    {
        return Err(SigCheckError::Malformed);
    }
    let slice = |off: u16, len: usize| -> core::result::Result<&[u8], SigCheckError> {
        let start = off as usize;
        let end = start.checked_add(len).ok_or(SigCheckError::Malformed)?;
        data.get(start..end).ok_or(SigCheckError::Malformed)
    };
    // The signature bytes themselves were checked by the runtime; we only
    // require that they lie inside this instruction.
    slice(signature_offset, SIGNATURE_LEN)?;
    let public_key = slice(public_key_offset, PUBKEY_LEN)?;
    let message = slice(message_offset, message_size as usize)?;

    if public_key != expected_signer.as_slice() {
        return Err(SigCheckError::SignerMismatch);
    }
    if message != expected_message {
        return Err(SigCheckError::MessageMismatch);
    }
    Ok(())
}

/// Loads the instruction immediately before the currently executing one from
/// the instructions sysvar and checks it with [`check_ed25519_ix`].
pub fn require_preceding_ed25519(
    instructions_sysvar: &AccountInfo,
    expected_signer: &[u8; 32],
    expected_message: &[u8],
) -> Result<()> {
    use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

    let current = load_current_index_checked(instructions_sysvar)?;
    if current == 0 {
        return err!(crate::BridgeError::MissingEd25519Instruction);
    }
    let prev = load_instruction_at_checked((current - 1) as usize, instructions_sysvar)?;
    check_ed25519_ix(&prev.program_id, &prev.data, expected_signer, expected_message).map_err(
        |e| match e {
            SigCheckError::Missing => error!(crate::BridgeError::MissingEd25519Instruction),
            SigCheckError::Malformed => error!(crate::BridgeError::MalformedEd25519Instruction),
            SigCheckError::SignerMismatch => error!(crate::BridgeError::Ed25519SignerMismatch),
            SigCheckError::MessageMismatch => error!(crate::BridgeError::Ed25519MessageMismatch),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_ed25519_program::new_ed25519_instruction_with_signature;

    const SIGNER: [u8; 32] = [7; 32];
    const MSG: &[u8] = b"settu quote bytes";

    fn good() -> Vec<u8> {
        new_ed25519_instruction_with_signature(MSG, &[9; 64], &SIGNER).data
    }

    fn check(data: &[u8]) -> core::result::Result<(), SigCheckError> {
        check_ed25519_ix(&ED25519_PROGRAM_ID, data, &SIGNER, MSG)
    }

    fn set_u16(d: &mut [u8], at: usize, v: u16) {
        d[at..at + 2].copy_from_slice(&v.to_le_bytes());
    }

    #[test]
    fn accepts_standard_single_signature_instruction() {
        assert_eq!(check(&good()), Ok(()));
    }

    #[test]
    fn rejects_other_program() {
        let other = Pubkey::new_from_array([1; 32]);
        assert_eq!(
            check_ed25519_ix(&other, &good(), &SIGNER, MSG),
            Err(SigCheckError::Missing)
        );
    }

    #[test]
    fn rejects_short_data_and_bad_header() {
        assert_eq!(check(&[]), Err(SigCheckError::Malformed));
        assert_eq!(check(&good()[..15]), Err(SigCheckError::Malformed));
        let mut d = good();
        d[0] = 0;
        assert_eq!(check(&d), Err(SigCheckError::Malformed));
        d[0] = 2;
        assert_eq!(check(&d), Err(SigCheckError::Malformed));
        let mut d = good();
        d[1] = 1;
        assert_eq!(check(&d), Err(SigCheckError::Malformed));
    }

    #[test]
    fn rejects_cross_instruction_references() {
        for at in [4usize, 8, 14] {
            for idx in [0u16, 1, 2, u16::MAX - 1] {
                let mut d = good();
                set_u16(&mut d, at, idx);
                assert_eq!(check(&d), Err(SigCheckError::Malformed), "index field {at} = {idx}");
            }
        }
    }

    #[test]
    fn rejects_out_of_bounds_offsets() {
        let len = good().len() as u16;
        // signature, pubkey, message offsets pushed past the end
        for (at, v) in [(2usize, len - 63), (6, len - 31), (10, len - MSG.len() as u16 + 1)] {
            let mut d = good();
            set_u16(&mut d, at, v);
            assert_eq!(check(&d), Err(SigCheckError::Malformed), "offset field {at}");
        }
        let mut d = good();
        set_u16(&mut d, 10, u16::MAX);
        assert_eq!(check(&d), Err(SigCheckError::Malformed));
        let mut d = good();
        set_u16(&mut d, 12, MSG.len() as u16 + 1);
        assert_eq!(check(&d), Err(SigCheckError::Malformed));
    }

    #[test]
    fn rejects_wrong_signer() {
        let d = new_ed25519_instruction_with_signature(MSG, &[9; 64], &[8; 32]).data;
        assert_eq!(check(&d), Err(SigCheckError::SignerMismatch));
    }

    #[test]
    fn rejects_different_message() {
        let d = new_ed25519_instruction_with_signature(b"settu quote bytez", &[9; 64], &SIGNER).data;
        assert_eq!(check(&d), Err(SigCheckError::MessageMismatch));
        // A prefix of the right message is not the message.
        let d = new_ed25519_instruction_with_signature(&MSG[..MSG.len() - 1], &[9; 64], &SIGNER).data;
        assert_eq!(check(&d), Err(SigCheckError::MessageMismatch));
        // Nor is the message plus trailing bytes.
        let mut longer = MSG.to_vec();
        longer.push(0);
        let d = new_ed25519_instruction_with_signature(&longer, &[9; 64], &SIGNER).data;
        assert_eq!(check(&d), Err(SigCheckError::MessageMismatch));
    }
}
