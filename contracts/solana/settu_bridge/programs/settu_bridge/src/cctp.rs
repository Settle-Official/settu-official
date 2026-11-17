//! Hand-written CPI into Circle's CCTP V2 TokenMessengerMinterV2.
//!
//! Source of truth: the on-chain IDL vendored at
//! src/lib/solana/idl/token_messenger_minter_v2.json (copied verbatim to
//! idls/token_messenger_minter_v2.json in this workspace; program
//! `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`, IDL version 0.2.0, repo
//! github.com/circlefin/solana-cctp-contracts). The same account layout is
//! used by `buildDepositForBurnIx` in src/lib/solana/deposit-for-burn.ts,
//! which was verified by a real devnet burn.
//!
//! Hand-written rather than `declare_program!` so the exact discriminators,
//! account order and writable/signer flags are visible here and pinned by a
//! unit test against the IDL (`idl_conformance` below).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke,
};

pub const TOKEN_MESSENGER_MINTER_V2_ID: Pubkey =
    pubkey!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
pub const MESSAGE_TRANSMITTER_V2_ID: Pubkey =
    pubkey!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");

/// IDL `instructions[name=deposit_for_burn].discriminator`.
pub const DEPOSIT_FOR_BURN_DISCRIMINATOR: [u8; 8] = [215, 60, 61, 46, 114, 55, 128, 176];
/// IDL `instructions[name=deposit_for_burn_with_hook].discriminator`.
pub const DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR: [u8; 8] =
    [111, 245, 62, 131, 204, 108, 223, 155];

/// (IDL account name, writable, signer), in IDL order. Identical for both
/// instructions.
pub const DEPOSIT_FOR_BURN_ACCOUNTS: [(&str, bool, bool); 18] = [
    ("owner", false, true),
    ("event_rent_payer", true, true),
    ("sender_authority_pda", false, false),
    ("burn_token_account", true, false),
    ("denylist_account", false, false),
    ("message_transmitter", true, false),
    ("token_messenger", false, false),
    ("remote_token_messenger", false, false),
    ("token_minter", false, false),
    ("local_token", true, false),
    ("burn_token_mint", true, false),
    ("message_sent_event_data", true, true),
    ("message_transmitter_program", false, false),
    ("token_messenger_minter_program", false, false),
    ("token_program", false, false),
    ("system_program", false, false),
    ("event_authority", false, false),
    ("program", false, false),
];

/// IDL type `DepositForBurnParams` (borsh, field order as in the IDL).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DepositForBurnParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
}

/// IDL type `DepositForBurnWithHookParams`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DepositForBurnWithHookParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
    pub hook_data: Vec<u8>,
}

/// Instruction data: `deposit_for_burn` when `hook_data` is empty, else
/// `deposit_for_burn_with_hook`. `destination_caller` is always zero, so
/// anyone may submit the mint (spec §5).
pub fn instruction_data(
    amount: u64,
    destination_domain: u32,
    mint_recipient: [u8; 32],
    max_fee: u64,
    min_finality_threshold: u32,
    hook_data: &[u8],
) -> Vec<u8> {
    let mint_recipient = Pubkey::new_from_array(mint_recipient);
    let destination_caller = Pubkey::default();
    let mut data = Vec::with_capacity(8 + 92 + hook_data.len());
    if hook_data.is_empty() {
        data.extend_from_slice(&DEPOSIT_FOR_BURN_DISCRIMINATOR);
        DepositForBurnParams {
            amount,
            destination_domain,
            mint_recipient,
            destination_caller,
            max_fee,
            min_finality_threshold,
        }
        .serialize(&mut data)
        .expect("vec write");
    } else {
        data.extend_from_slice(&DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR);
        DepositForBurnWithHookParams {
            amount,
            destination_domain,
            mint_recipient,
            destination_caller,
            max_fee,
            min_finality_threshold,
            hook_data: hook_data.to_vec(),
        }
        .serialize(&mut data)
        .expect("vec write");
    }
    data
}

/// The 18 accounts, in [`DEPOSIT_FOR_BURN_ACCOUNTS`] order.
pub struct DepositForBurnAccounts<'a, 'info> {
    pub owner: &'a AccountInfo<'info>,
    pub event_rent_payer: &'a AccountInfo<'info>,
    pub sender_authority_pda: &'a AccountInfo<'info>,
    pub burn_token_account: &'a AccountInfo<'info>,
    pub denylist_account: &'a AccountInfo<'info>,
    pub message_transmitter: &'a AccountInfo<'info>,
    pub token_messenger: &'a AccountInfo<'info>,
    pub remote_token_messenger: &'a AccountInfo<'info>,
    pub token_minter: &'a AccountInfo<'info>,
    pub local_token: &'a AccountInfo<'info>,
    pub burn_token_mint: &'a AccountInfo<'info>,
    pub message_sent_event_data: &'a AccountInfo<'info>,
    pub message_transmitter_program: &'a AccountInfo<'info>,
    pub token_messenger_minter_program: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
}

impl<'a, 'info> DepositForBurnAccounts<'a, 'info> {
    fn infos(&self) -> [&'a AccountInfo<'info>; 18] {
        [
            self.owner,
            self.event_rent_payer,
            self.sender_authority_pda,
            self.burn_token_account,
            self.denylist_account,
            self.message_transmitter,
            self.token_messenger,
            self.remote_token_messenger,
            self.token_minter,
            self.local_token,
            self.burn_token_mint,
            self.message_sent_event_data,
            self.message_transmitter_program,
            self.token_messenger_minter_program,
            self.token_program,
            self.system_program,
            self.event_authority,
            self.program,
        ]
    }
}

/// Account metas for the given keys, with the IDL's flags.
pub fn account_metas(keys: &[Pubkey; 18]) -> Vec<AccountMeta> {
    keys.iter()
        .zip(DEPOSIT_FOR_BURN_ACCOUNTS.iter())
        .map(|(k, (_, writable, signer))| {
            if *writable {
                AccountMeta::new(*k, *signer)
            } else {
                AccountMeta::new_readonly(*k, *signer)
            }
        })
        .collect()
}

/// CPI into TokenMessengerMinterV2. `owner`, `event_rent_payer` and
/// `message_sent_event_data` must be transaction signers (no PDA signing).
pub fn deposit_for_burn<'a, 'info>(accounts: DepositForBurnAccounts<'a, 'info>, data: Vec<u8>) -> Result<()> {
    let infos = accounts.infos();
    let keys: [Pubkey; 18] = core::array::from_fn(|i| *infos[i].key);
    let ix = Instruction {
        program_id: TOKEN_MESSENGER_MINTER_V2_ID,
        accounts: account_metas(&keys),
        data,
    };
    let owned: Vec<AccountInfo<'info>> = infos.iter().map(|a| (*a).clone()).collect();
    invoke(&ix, &owned).map_err(Into::into)
}

#[cfg(test)]
mod idl_conformance {
    use super::*;

    const IDL: &str = include_str!("../../../idls/token_messenger_minter_v2.json");
    const SRC_IDL: &str = include_str!("../../../../../../src/lib/solana/idl/token_messenger_minter_v2.json");

    fn idl() -> serde_json::Value {
        serde_json::from_str(IDL).unwrap()
    }

    fn ix(name: &str) -> serde_json::Value {
        idl()["instructions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["name"] == name)
            .unwrap()
            .clone()
    }

    fn type_fields(name: &str) -> Vec<(String, String)> {
        let t = idl()["types"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == name)
            .unwrap()
            .clone();
        t["type"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| (f["name"].as_str().unwrap().to_string(), f["type"].to_string()))
            .collect()
    }

    #[test]
    fn workspace_idl_is_the_vendored_one() {
        let a: serde_json::Value = serde_json::from_str(IDL).unwrap();
        let b: serde_json::Value = serde_json::from_str(SRC_IDL).unwrap();
        assert_eq!(a, b);
        assert_eq!(a["address"], TOKEN_MESSENGER_MINTER_V2_ID.to_string());
    }

    #[test]
    fn discriminators_match_idl() {
        let d = |n: &str| -> Vec<u8> {
            ix(n)["discriminator"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect()
        };
        assert_eq!(d("deposit_for_burn"), DEPOSIT_FOR_BURN_DISCRIMINATOR.to_vec());
        assert_eq!(
            d("deposit_for_burn_with_hook"),
            DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR.to_vec()
        );
    }

    #[test]
    fn account_layout_matches_idl() {
        for name in ["deposit_for_burn", "deposit_for_burn_with_hook"] {
            let accts: Vec<(String, bool, bool)> = ix(name)["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|a| {
                    (
                        a["name"].as_str().unwrap().to_string(),
                        a["writable"].as_bool().unwrap_or(false),
                        a["signer"].as_bool().unwrap_or(false),
                    )
                })
                .collect();
            let ours: Vec<(String, bool, bool)> = DEPOSIT_FOR_BURN_ACCOUNTS
                .iter()
                .map(|(n, w, s)| (n.to_string(), *w, *s))
                .collect();
            assert_eq!(accts, ours, "{name}");
            // Fixed addresses in the IDL.
            let addr = |n: &str| {
                ix(name)["accounts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|a| a["name"] == n)
                    .unwrap()["address"]
                    .as_str()
                    .unwrap()
                    .to_string()
            };
            assert_eq!(addr("message_transmitter_program"), MESSAGE_TRANSMITTER_V2_ID.to_string());
            assert_eq!(addr("token_messenger_minter_program"), TOKEN_MESSENGER_MINTER_V2_ID.to_string());
        }
    }

    #[test]
    fn param_layout_matches_idl() {
        let base = vec![
            ("amount", "\"u64\""),
            ("destination_domain", "\"u32\""),
            ("mint_recipient", "\"pubkey\""),
            ("destination_caller", "\"pubkey\""),
            ("max_fee", "\"u64\""),
            ("min_finality_threshold", "\"u32\""),
        ];
        let to_owned = |v: &[(&str, &str)]| -> Vec<(String, String)> {
            v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
        };
        assert_eq!(type_fields("DepositForBurnParams"), to_owned(&base));
        let mut hook = base.clone();
        hook.push(("hook_data", "\"bytes\""));
        assert_eq!(type_fields("DepositForBurnWithHookParams"), to_owned(&hook));
    }

    #[test]
    fn instruction_data_encoding() {
        let data = instruction_data(4_975_000, 6, [0xab; 32], 650, 1000, &[]);
        assert_eq!(&data[..8], &DEPOSIT_FOR_BURN_DISCRIMINATOR);
        assert_eq!(data.len(), 8 + 8 + 4 + 32 + 32 + 8 + 4);
        assert_eq!(&data[8..16], &4_975_000u64.to_le_bytes());
        assert_eq!(&data[16..20], &6u32.to_le_bytes());
        assert_eq!(&data[20..52], &[0xab; 32]);
        assert_eq!(&data[52..84], &[0u8; 32], "destination_caller is zero");
        assert_eq!(&data[84..92], &650u64.to_le_bytes());
        assert_eq!(&data[92..96], &1000u32.to_le_bytes());

        let data = instruction_data(1, 27, [1; 32], 0, 2000, &[9, 8, 7]);
        assert_eq!(&data[..8], &DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR);
        assert_eq!(&data[96..100], &3u32.to_le_bytes());
        assert_eq!(&data[100..], &[9, 8, 7]);
    }

    #[test]
    fn anchor_sighash_matches() {
        // Circle's program is Anchor: discriminator = sha256("global:<name>")[..8].
        // The test mock relies on this to receive the same instruction.
        use sha2::{Digest, Sha256};
        let h = |s: &[u8]| Sha256::digest(s)[..8].to_vec();
        assert_eq!(h(b"global:deposit_for_burn"), DEPOSIT_FOR_BURN_DISCRIMINATOR.to_vec());
        assert_eq!(
            h(b"global:deposit_for_burn_with_hook"),
            DEPOSIT_FOR_BURN_WITH_HOOK_DISCRIMINATOR.to_vec()
        );
    }
}
