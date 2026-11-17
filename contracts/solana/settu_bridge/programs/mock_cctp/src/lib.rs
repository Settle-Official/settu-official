//! TEST ONLY. A stand-in for Circle's CCTP V2 TokenMessengerMinterV2 that the
//! settu_bridge LiteSVM tests load at Circle's real program id. NEVER deploy.
//!
//! Mirrors the vendored IDL (src/lib/solana/idl/token_messenger_minter_v2.json):
//! same instruction names (so the same Anchor discriminators), same 18
//! accounts in the same order with the same signer/writable flags, same
//! params. It mirrors these Circle checks:
//! - `owner`, `event_rent_payer`, `message_sent_event_data` are signers;
//! - `burn_token_account` is owned by `owner` and holds `burn_token_mint`;
//! - every PDA is at Circle's seeds (MessageTransmitter PDA under
//!   MessageTransmitterV2), `remote_token_messenger` for the destination domain;
//! - the denylist PDA for `owner` does not exist;
//! - `amount > 0`, `max_fee < amount`, non-zero `mint_recipient`;
//! - `deposit_for_burn_with_hook` rejects empty `hook_data`.
//!
//! Then, like Circle, it burns `amount` from `burn_token_account` with the
//! owner's authority and creates `message_sent_event_data` (rent from
//! `event_rent_payer`), into which it records every argument so the tests can
//! assert exactly what settu_bridge sent.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount};

declare_id!("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");

pub const MESSAGE_TRANSMITTER_V2_ID: Pubkey =
    anchor_lang::pubkey!("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");

pub const RECORD_SPACE: usize = 8 + 1 + 32 + 32 + 8 + 4 + 32 + 32 + 8 + 4 + 4 + 512;

#[program]
pub mod mock_cctp {
    use super::*;

    pub fn deposit_for_burn(ctx: Context<DepositForBurnContext>, params: DepositForBurnParams) -> Result<()> {
        record(
            ctx,
            false,
            params.amount,
            params.destination_domain,
            params.mint_recipient,
            params.destination_caller,
            params.max_fee,
            params.min_finality_threshold,
            Vec::new(),
        )
    }

    pub fn deposit_for_burn_with_hook(
        ctx: Context<DepositForBurnContext>,
        params: DepositForBurnWithHookParams,
    ) -> Result<()> {
        require!(!params.hook_data.is_empty(), MockError::InvalidHookData);
        record(
            ctx,
            true,
            params.amount,
            params.destination_domain,
            params.mint_recipient,
            params.destination_caller,
            params.max_fee,
            params.min_finality_threshold,
            params.hook_data,
        )
    }
}

#[allow(clippy::too_many_arguments)]
fn record(
    ctx: Context<DepositForBurnContext>,
    with_hook: bool,
    amount: u64,
    destination_domain: u32,
    mint_recipient: Pubkey,
    destination_caller: Pubkey,
    max_fee: u64,
    min_finality_threshold: u32,
    hook_data: Vec<u8>,
) -> Result<()> {
    require!(amount > 0, MockError::InvalidAmount);
    require!(max_fee < amount, MockError::InvalidMaxFee);
    require!(mint_recipient != Pubkey::default(), MockError::InvalidMintRecipient);
    let (remote, _) = Pubkey::find_program_address(
        &[b"remote_token_messenger", destination_domain.to_string().as_bytes()],
        &crate::ID,
    );
    require_keys_eq!(ctx.accounts.remote_token_messenger.key(), remote, MockError::BadPda);
    require!(
        ctx.accounts.denylist_account.lamports() == 0,
        MockError::Denylisted
    );

    token::burn(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Burn {
                mint: ctx.accounts.burn_token_mint.to_account_info(),
                from: ctx.accounts.burn_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    let r = &mut ctx.accounts.message_sent_event_data;
    r.with_hook = with_hook;
    r.depositor = ctx.accounts.owner.key();
    r.burn_token = ctx.accounts.burn_token_mint.key();
    r.amount = amount;
    r.destination_domain = destination_domain;
    r.mint_recipient = mint_recipient;
    r.destination_caller = destination_caller;
    r.max_fee = max_fee;
    r.min_finality_threshold = min_finality_threshold;
    r.hook_data = hook_data;
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositForBurnParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DepositForBurnWithHookParams {
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
    pub hook_data: Vec<u8>,
}

/// What the mock recorded (stand-in for Circle's MessageSent account).
#[account]
pub struct BurnRecord {
    pub with_hook: bool,
    pub depositor: Pubkey,
    pub burn_token: Pubkey,
    pub amount: u64,
    pub destination_domain: u32,
    pub mint_recipient: Pubkey,
    pub destination_caller: Pubkey,
    pub max_fee: u64,
    pub min_finality_threshold: u32,
    pub hook_data: Vec<u8>,
}

#[derive(Accounts)]
pub struct DepositForBurnContext<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub event_rent_payer: Signer<'info>,
    /// CHECK: PDA
    #[account(seeds = [b"sender_authority"], bump)]
    pub sender_authority_pda: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = burn_token_account.owner == owner.key() @ MockError::InvalidOwner,
        constraint = burn_token_account.mint == burn_token_mint.key() @ MockError::InvalidMint,
    )]
    pub burn_token_account: Account<'info, TokenAccount>,
    /// CHECK: PDA; denylisted if it exists.
    #[account(seeds = [b"denylist_account", owner.key().as_ref()], bump)]
    pub denylist_account: UncheckedAccount<'info>,
    /// CHECK: MessageTransmitterV2 PDA
    #[account(mut, seeds = [b"message_transmitter"], bump, seeds::program = MESSAGE_TRANSMITTER_V2_ID)]
    pub message_transmitter: UncheckedAccount<'info>,
    /// CHECK: PDA
    #[account(seeds = [b"token_messenger"], bump)]
    pub token_messenger: UncheckedAccount<'info>,
    /// CHECK: PDA for the destination domain, checked in the handler.
    pub remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: PDA
    #[account(seeds = [b"token_minter"], bump)]
    pub token_minter: UncheckedAccount<'info>,
    /// CHECK: PDA
    #[account(mut, seeds = [b"local_token", burn_token_mint.key().as_ref()], bump)]
    pub local_token: UncheckedAccount<'info>,
    #[account(mut)]
    pub burn_token_mint: Account<'info, Mint>,
    #[account(init, payer = event_rent_payer, space = RECORD_SPACE)]
    pub message_sent_event_data: Account<'info, BurnRecord>,
    /// CHECK: fixed address
    #[account(address = MESSAGE_TRANSMITTER_V2_ID)]
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = crate::ID)]
    pub token_messenger_minter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: PDA
    #[account(seeds = [b"__event_authority"], bump)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
}

#[error_code]
pub enum MockError {
    InvalidAmount,
    InvalidMaxFee,
    InvalidMintRecipient,
    InvalidHookData,
    InvalidOwner,
    InvalidMint,
    BadPda,
    Denylisted,
}
