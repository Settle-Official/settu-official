//! The Settu bridge quote and the exact bytes the quote signer signs.
//!
//! Must match `encodeQuoteBytes(quote, "solana", programId)` in
//! src/lib/bridge/quote.ts byte for byte. Layout (all integers big-endian):
//!
//! "SETTU_BRIDGE_V1" (15 ASCII) | program id 32 | sourceDomain u32 |
//! destDomain u32 | user 32 | amount u64 | settuFee u64 | networkFee u64 |
//! nativeFee u64 | mintRecipient 32 | maxFee u64 | minFinality u32 |
//! deadline u64 | nonce 32 | hookData len u32 | hookData
//!
//! Pinned by the `solana` case of contracts/test-vectors/quotes.json.
//!
//! Units: `amount`, `settu_fee`, `network_fee`, `max_fee` are USDC atomic
//! (6 decimals). `native_fee` is lamports.

use anchor_lang::prelude::*;

pub const QUOTE_PREFIX: &[u8; 15] = b"SETTU_BRIDGE_V1";
pub const QUOTE_FIXED_LENGTH: usize =
    15 + 32 + 4 + 4 + 32 + 8 + 8 + 8 + 8 + 32 + 8 + 4 + 8 + 32 + 4;

/// The signed quote, passed as the `bridge` instruction argument.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct QuoteArgs {
    pub source_domain: u32,
    pub dest_domain: u32,
    /// The Solana wallet that must sign the bridge transaction.
    pub user: Pubkey,
    pub amount: u64,
    pub settu_fee: u64,
    pub network_fee: u64,
    pub native_fee: u64,
    /// CCTP `mint_recipient` (bytes32) on the destination chain.
    pub mint_recipient: [u8; 32],
    pub max_fee: u64,
    pub min_finality: u32,
    /// Unix seconds.
    pub deadline: u64,
    pub nonce: [u8; 32],
    /// Empty unless the destination is Stellar (then the forwarder hook).
    pub hook_data: Vec<u8>,
}

/// The exact message the Settu quote signer signs for `program_id`.
pub fn quote_message(program_id: &Pubkey, q: &QuoteArgs) -> Vec<u8> {
    let mut b = Vec::with_capacity(QUOTE_FIXED_LENGTH + q.hook_data.len());
    b.extend_from_slice(QUOTE_PREFIX);
    b.extend_from_slice(program_id.as_ref());
    b.extend_from_slice(&q.source_domain.to_be_bytes());
    b.extend_from_slice(&q.dest_domain.to_be_bytes());
    b.extend_from_slice(q.user.as_ref());
    b.extend_from_slice(&q.amount.to_be_bytes());
    b.extend_from_slice(&q.settu_fee.to_be_bytes());
    b.extend_from_slice(&q.network_fee.to_be_bytes());
    b.extend_from_slice(&q.native_fee.to_be_bytes());
    b.extend_from_slice(&q.mint_recipient);
    b.extend_from_slice(&q.max_fee.to_be_bytes());
    b.extend_from_slice(&q.min_finality.to_be_bytes());
    b.extend_from_slice(&q.deadline.to_be_bytes());
    b.extend_from_slice(&q.nonce);
    // hook_data is bounded by the transaction size (< 1232 bytes), so the
    // u32 length never truncates.
    b.extend_from_slice(&(q.hook_data.len() as u32).to_be_bytes());
    b.extend_from_slice(&q.hook_data);
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signature, SigningKey, Verifier, VerifyingKey};
    use std::str::FromStr;

    const VECTORS: &str = include_str!("../../../../../test-vectors/quotes.json");

    fn hex32(s: &str) -> [u8; 32] {
        hex::decode(s.trim_start_matches("0x")).unwrap().try_into().unwrap()
    }

    fn solana_case() -> serde_json::Value {
        let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        v["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == "solana")
            .expect("solana case")
            .clone()
    }

    fn quote_from_case(c: &serde_json::Value) -> QuoteArgs {
        let q = &c["quote"];
        let n = |k: &str| q[k].as_str().unwrap().parse::<u64>().unwrap();
        QuoteArgs {
            source_domain: q["sourceDomain"].as_u64().unwrap() as u32,
            dest_domain: q["destDomain"].as_u64().unwrap() as u32,
            user: Pubkey::from_str(q["user"].as_str().unwrap()).unwrap(),
            amount: n("amount"),
            settu_fee: n("settuFee"),
            network_fee: n("networkFee"),
            native_fee: n("nativeFee"),
            mint_recipient: hex32(q["mintRecipient"].as_str().unwrap()),
            max_fee: n("maxFee"),
            min_finality: q["minFinality"].as_u64().unwrap() as u32,
            deadline: n("deadline"),
            nonce: hex32(q["nonce"].as_str().unwrap()),
            hook_data: hex::decode(q["hookData"].as_str().unwrap().trim_start_matches("0x"))
                .unwrap(),
        }
    }

    #[test]
    fn golden_vector_rebuilds_exact_bytes() {
        let c = solana_case();
        let program_id = Pubkey::from_str(c["contractId"].as_str().unwrap()).unwrap();
        assert_eq!(program_id.to_bytes(), hex32(c["contractIdHex"].as_str().unwrap()));
        let q = quote_from_case(&c);
        assert_eq!(q.user.to_bytes(), hex32(c["userHex"].as_str().unwrap()));
        let expected = hex::decode(c["encoded"].as_str().unwrap().trim_start_matches("0x")).unwrap();
        let got = quote_message(&program_id, &q);
        assert_eq!(hex::encode(&got), hex::encode(&expected));
        assert_eq!(got.len(), QUOTE_FIXED_LENGTH + q.hook_data.len());
    }

    #[test]
    fn golden_vector_signature_verifies() {
        let v: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let c = solana_case();
        let program_id = Pubkey::from_str(c["contractId"].as_str().unwrap()).unwrap();
        let msg = quote_message(&program_id, &quote_from_case(&c));

        // The vector's signer is the RFC 8032 TEST 1 key.
        let seed = hex32(v["testOnlyKeys"]["ed25519Seed"].as_str().unwrap());
        let signer = hex32(c["signer"].as_str().unwrap());
        assert_eq!(SigningKey::from_bytes(&seed).verifying_key().to_bytes(), signer);

        let sig: [u8; 64] = hex::decode(c["signature"].as_str().unwrap().trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap();
        let vk = VerifyingKey::from_bytes(&signer).unwrap();
        vk.verify(&msg, &Signature::from_bytes(&sig)).expect("golden signature verifies");

        // And the on-chain parser accepts the Ed25519SigVerify instruction a
        // client would build from it.
        let ix = solana_ed25519_program::new_ed25519_instruction_with_signature(&msg, &sig, &signer);
        crate::ed25519::check_ed25519_ix(&ix.program_id, &ix.data, &signer, &msg)
            .expect("parser accepts golden instruction");

        // A one-byte change to any field breaks the signature.
        let mut tampered = msg.clone();
        tampered[QUOTE_FIXED_LENGTH - 40] ^= 1;
        assert!(vk.verify(&tampered, &Signature::from_bytes(&sig)).is_err());
    }

    #[test]
    fn hook_data_is_length_prefixed() {
        let q = QuoteArgs {
            source_domain: 5,
            dest_domain: 27,
            user: Pubkey::new_from_array([4; 32]),
            amount: 1,
            settu_fee: 2,
            network_fee: 3,
            native_fee: 4,
            mint_recipient: [5; 32],
            max_fee: 6,
            min_finality: 2000,
            deadline: 7,
            nonce: [8; 32],
            hook_data: vec![0xaa, 0xbb, 0xcc],
        };
        let m = quote_message(&Pubkey::new_from_array([2; 32]), &q);
        assert_eq!(m.len(), QUOTE_FIXED_LENGTH + 3);
        assert_eq!(&m[QUOTE_FIXED_LENGTH - 4..QUOTE_FIXED_LENGTH], &[0, 0, 0, 3]);
        assert_eq!(&m[QUOTE_FIXED_LENGTH..], &[0xaa, 0xbb, 0xcc]);
    }
}
