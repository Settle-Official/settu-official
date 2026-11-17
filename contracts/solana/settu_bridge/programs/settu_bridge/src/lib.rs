//! # Settu bridge (Solana / Anchor)
//!
//! Bridges a Solana user's USDC through Circle CCTP V2 in ONE transaction:
//!
//! 1. an Ed25519SigVerify instruction (immediately before `bridge`) proves the
//!    Settu quote signer signed `quote_message(program_id, quote)`;
//! 2. `bridge` checks the quote (pause, deadline, nonce, user, domain, limits),
//!    moves `settu_fee + network_fee` USDC from the user's token account to the
//!    fee wallet's USDC ATA and `native_fee` lamports from the user to the fee
//!    wallet;
//! 3. CPIs Circle's TokenMessengerMinterV2 `deposit_for_burn` (or
//!    `deposit_for_burn_with_hook` when `hook_data` is non-empty) for
//!    `amount - settu_fee - network_fee`, with the user as owner and rent payer;
//! 4. emits `Bridged`.
//!
//! The program never holds funds: it owns no token accounts, and its only
//! lamports are the rent of its config account. Nonce records are rent-paid by
//! the user and never closed, so a nonce can never be reused.
//!
//! See spec §5 / §5.3 in docs/superpowers/specs/2026-11-16-user-bridge-design.md
//! and the EVM (contracts/evm/src/SettuBridge.sol) and Stellar
//! (contracts/stellar/settu-bridge) contracts, which share these semantics.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::system_program;
use anchor_spl::associated_token::get_associated_token_address;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub mod cctp;
pub mod ed25519;
pub mod quote;

pub use quote::{quote_message, QuoteArgs};

declare_id!("3CGxb2E9ASpizQtoL8wykokiZ8BH19MXMWmgy17KQmD1");

pub const CONFIG_SEED: &[u8] = b"config";
pub const NONCE_SEED: &[u8] = b"nonce";
/// CCTP domain of Solana.
pub const SOLANA_DOMAIN: u32 = 5;
pub const BPS_DENOMINATOR: u16 = 10_000;
/// Initial `max_fee_bps` per the shared contract rules (1%).
pub const DEFAULT_MAX_FEE_BPS: u16 = 100;

pub const INSTRUCTIONS_SYSVAR_ID: Pubkey =
    anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");

#[program]
pub mod settu_bridge {
    use super::*;

    /// One-time setup. Only the program's upgrade authority may call it (so a
    /// freshly deployed program can't be claimed by a front-runner); that
    /// signer becomes the owner. Use `transfer_ownership` to hand it to the
    /// business owner's wallet.
    pub fn initialize(
        ctx: Context<Initialize>,
        signer: Pubkey,
        fee_wallet: Pubkey,
        max_fee_bps: u16,
        max_network_fee: u64,
        max_native_fee: u64,
    ) -> Result<()> {
        require!(signer != Pubkey::default(), BridgeError::ZeroAddress);
        require!(fee_wallet != Pubkey::default(), BridgeError::ZeroAddress);
        require!(max_fee_bps <= BPS_DENOMINATOR, BridgeError::InvalidBps);
        let c = &mut ctx.accounts.config;
        c.owner = ctx.accounts.authority.key();
        c.pending_owner = None;
        c.signer = signer;
        c.fee_wallet = fee_wallet;
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.max_fee_bps = max_fee_bps;
        c.max_network_fee = max_network_fee;
        c.max_native_fee = max_native_fee;
        c.paused = false;
        c.bump = ctx.bumps.config;
        emit!(SignerUpdated { previous: Pubkey::default(), current: signer });
        emit!(FeeWalletUpdated { previous: Pubkey::default(), current: fee_wallet });
        emit!(MaxFeeBpsUpdated { previous: 0, current: max_fee_bps });
        emit!(MaxNetworkFeeUpdated { previous: 0, current: max_network_fee });
        emit!(MaxNativeFeeUpdated { previous: 0, current: max_native_fee });
        Ok(())
    }

    /// Pays the quoted fees and burns the rest of `quote.amount` through CCTP.
    /// Must be immediately preceded by an Ed25519SigVerify instruction over
    /// `quote_message(program_id, quote)` with the stored signer key.
    pub fn bridge(ctx: Context<Bridge>, quote: QuoteArgs) -> Result<()> {
        let q = quote;
        let config = &ctx.accounts.config;

        // 1. Not paused.
        require!(!config.paused, BridgeError::Paused);
        // 2. Deadline.
        let now = Clock::get()?.unix_timestamp;
        require!(now >= 0 && (now as u64) <= q.deadline, BridgeError::QuoteExpired);
        // 3. Nonce: `nonce_record` is `init`, so a used nonce already failed.
        // 4. This user, this chain.
        require_keys_eq!(q.user, ctx.accounts.user.key(), BridgeError::WrongUser);
        require!(q.source_domain == SOLANA_DOMAIN, BridgeError::WrongSourceDomain);
        require!(q.amount > 0, BridgeError::InvalidAmount);
        // 5. Limits (u128: no overflow for any u64 inputs).
        require!(
            (q.settu_fee as u128) * (BPS_DENOMINATOR as u128)
                <= (config.max_fee_bps as u128) * (q.amount as u128),
            BridgeError::FeeAboveCap
        );
        require!(q.network_fee <= config.max_network_fee, BridgeError::NetworkFeeAboveMax);
        require!(q.native_fee <= config.max_native_fee, BridgeError::NativeFeeAboveMax);
        let usdc_fee = q
            .settu_fee
            .checked_add(q.network_fee)
            .ok_or(BridgeError::NothingToBurn)?;
        let burn = q
            .amount
            .checked_sub(usdc_fee)
            .filter(|b| *b > 0)
            .ok_or(BridgeError::NothingToBurn)?;
        // 6. Signature.
        let message = quote_message(ctx.program_id, &q);
        ed25519::require_preceding_ed25519(
            &ctx.accounts.instructions.to_account_info(),
            &config.signer.to_bytes(),
            &message,
        )?;

        // 7. Fees: user -> fee wallet.
        if usdc_fee > 0 {
            token::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.burn_token_account.to_account_info(),
                        mint: ctx.accounts.usdc_mint.to_account_info(),
                        to: ctx.accounts.fee_token_account.to_account_info(),
                        authority: ctx.accounts.user.to_account_info(),
                    },
                ),
                usdc_fee,
                ctx.accounts.usdc_mint.decimals,
            )?;
        }
        if q.native_fee > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: ctx.accounts.user.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                    },
                ),
                q.native_fee,
            )?;
        }

        // 8. Burn the rest through CCTP, user as owner + event rent payer.
        let a = &ctx.accounts;
        let user = a.user.to_account_info();
        let burn_token_account = a.burn_token_account.to_account_info();
        let burn_token_mint = a.usdc_mint.to_account_info();
        let message_sent_event_data = a.message_sent_event_data.to_account_info();
        let token_program = a.token_program.to_account_info();
        let system_program = a.system_program.to_account_info();
        let tmm = a.token_messenger_minter_program.to_account_info();
        cctp::deposit_for_burn(
            cctp::DepositForBurnAccounts {
                owner: &user,
                event_rent_payer: &user,
                sender_authority_pda: a.sender_authority_pda.as_ref(),
                burn_token_account: &burn_token_account,
                denylist_account: a.denylist_account.as_ref(),
                message_transmitter: a.message_transmitter.as_ref(),
                token_messenger: a.token_messenger.as_ref(),
                remote_token_messenger: a.remote_token_messenger.as_ref(),
                token_minter: a.token_minter.as_ref(),
                local_token: a.local_token.as_ref(),
                burn_token_mint: &burn_token_mint,
                message_sent_event_data: &message_sent_event_data,
                message_transmitter_program: a.message_transmitter_program.as_ref(),
                token_messenger_minter_program: &tmm,
                token_program: &token_program,
                system_program: &system_program,
                event_authority: a.event_authority.as_ref(),
                program: &tmm,
            },
            cctp::instruction_data(
                burn,
                q.dest_domain,
                q.mint_recipient,
                q.max_fee,
                q.min_finality,
                &q.hook_data,
            ),
        )?;

        // 9. Event.
        emit!(Bridged {
            nonce: q.nonce,
            user: q.user,
            amount: q.amount,
            settu_fee: q.settu_fee,
            network_fee: q.network_fee,
            native_fee: q.native_fee,
            dest_domain: q.dest_domain,
            mint_recipient: q.mint_recipient,
            min_finality: q.min_finality,
        });
        Ok(())
    }

    // ------------------------------------------------------------ owner

    pub fn set_signer(ctx: Context<OwnerOnly>, signer: Pubkey) -> Result<()> {
        require!(signer != Pubkey::default(), BridgeError::ZeroAddress);
        let c = &mut ctx.accounts.config;
        emit!(SignerUpdated { previous: c.signer, current: signer });
        c.signer = signer;
        Ok(())
    }

    /// The new fee wallet must already have a USDC ATA, or bridges fail.
    pub fn set_fee_wallet(ctx: Context<OwnerOnly>, fee_wallet: Pubkey) -> Result<()> {
        require!(fee_wallet != Pubkey::default(), BridgeError::ZeroAddress);
        let c = &mut ctx.accounts.config;
        emit!(FeeWalletUpdated { previous: c.fee_wallet, current: fee_wallet });
        c.fee_wallet = fee_wallet;
        Ok(())
    }

    pub fn set_max_fee_bps(ctx: Context<OwnerOnly>, max_fee_bps: u16) -> Result<()> {
        require!(max_fee_bps <= BPS_DENOMINATOR, BridgeError::InvalidBps);
        let c = &mut ctx.accounts.config;
        emit!(MaxFeeBpsUpdated { previous: c.max_fee_bps, current: max_fee_bps });
        c.max_fee_bps = max_fee_bps;
        Ok(())
    }

    pub fn set_max_network_fee(ctx: Context<OwnerOnly>, max_network_fee: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        emit!(MaxNetworkFeeUpdated { previous: c.max_network_fee, current: max_network_fee });
        c.max_network_fee = max_network_fee;
        Ok(())
    }

    pub fn set_max_native_fee(ctx: Context<OwnerOnly>, max_native_fee: u64) -> Result<()> {
        let c = &mut ctx.accounts.config;
        emit!(MaxNativeFeeUpdated { previous: c.max_native_fee, current: max_native_fee });
        c.max_native_fee = max_native_fee;
        Ok(())
    }

    pub fn set_paused(ctx: Context<OwnerOnly>, paused: bool) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.paused = paused;
        emit!(PausedSet { owner: c.owner, paused });
        Ok(())
    }

    /// Step 1 of 2: nominate `new_owner` (replaces any pending nominee).
    pub fn transfer_ownership(ctx: Context<OwnerOnly>, new_owner: Pubkey) -> Result<()> {
        require!(new_owner != Pubkey::default(), BridgeError::ZeroAddress);
        let c = &mut ctx.accounts.config;
        c.pending_owner = Some(new_owner);
        emit!(OwnershipTransferStarted { previous: c.owner, pending: new_owner });
        Ok(())
    }

    /// Step 2 of 2: the nominee accepts.
    pub fn accept_ownership(ctx: Context<AcceptOwnership>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        let previous = c.owner;
        c.owner = ctx.accounts.pending_owner.key();
        c.pending_owner = None;
        emit!(OwnershipTransferred { previous, current: c.owner });
        Ok(())
    }
}

// ------------------------------------------------------------------ state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub owner: Pubkey,
    pub pending_owner: Option<Pubkey>,
    /// ed25519 public key of the Settu quote signer.
    pub signer: Pubkey,
    /// Receives USDC fees (at its USDC ATA) and the native fee (lamports).
    pub fee_wallet: Pubkey,
    pub usdc_mint: Pubkey,
    pub max_fee_bps: u16,
    /// USDC atomic (6 decimals).
    pub max_network_fee: u64,
    /// Lamports.
    pub max_native_fee: u64,
    pub paused: bool,
    pub bump: u8,
}

/// Existence = nonce used. Never closed.
#[account]
#[derive(InitSpace)]
pub struct NonceRecord {}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, Config>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        constraint = program.programdata_address()? == Some(program_data.key())
            @ BridgeError::NotUpgradeAuthority,
    )]
    pub program: Program<'info, crate::program::SettuBridge>,
    #[account(
        owner = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(authority.key())
            @ BridgeError::NotUpgradeAuthority,
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(quote: QuoteArgs)]
pub struct Bridge<'info> {
    /// Signs the transaction; pays the nonce record and CCTP event rent.
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init,
        payer = user,
        space = 8 + NonceRecord::INIT_SPACE,
        seeds = [NONCE_SEED, quote.nonce.as_ref()],
        bump,
    )]
    pub nonce_record: Account<'info, NonceRecord>,
    /// The user's USDC token account: pays the fees and is burned from.
    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = user,
    )]
    pub burn_token_account: Box<Account<'info, TokenAccount>>,
    /// CHECK: must be the configured fee wallet; receives lamports only.
    #[account(mut, address = config.fee_wallet @ BridgeError::WrongFeeWallet)]
    pub fee_wallet: UncheckedAccount<'info>,
    /// The fee wallet's USDC associated token account.
    #[account(
        mut,
        address = get_associated_token_address(&config.fee_wallet, &config.usdc_mint)
            @ BridgeError::WrongFeeTokenAccount,
    )]
    pub fee_token_account: Box<Account<'info, TokenAccount>>,
    /// USDC (CCTP `burn_token_mint`).
    #[account(mut, address = config.usdc_mint @ BridgeError::WrongMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,

    // ---- Circle CCTP V2 accounts, validated by TokenMessengerMinterV2 itself.
    /// CHECK: Circle PDA ["sender_authority"].
    pub sender_authority_pda: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["denylist_account", user].
    pub denylist_account: UncheckedAccount<'info>,
    /// CHECK: MessageTransmitterV2 PDA ["message_transmitter"].
    #[account(mut)]
    pub message_transmitter: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["token_messenger"].
    pub token_messenger: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["remote_token_messenger", dest domain as decimal string].
    pub remote_token_messenger: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["token_minter"].
    pub token_minter: UncheckedAccount<'info>,
    /// CHECK: Circle PDA ["local_token", usdc_mint].
    #[account(mut)]
    pub local_token: UncheckedAccount<'info>,
    /// Fresh keypair; Circle creates the MessageSent account here.
    #[account(mut)]
    pub message_sent_event_data: Signer<'info>,
    /// CHECK: pinned to Circle's MessageTransmitterV2 id.
    #[account(address = cctp::MESSAGE_TRANSMITTER_V2_ID @ BridgeError::WrongCctpProgram)]
    pub message_transmitter_program: UncheckedAccount<'info>,
    /// CHECK: pinned to Circle's TokenMessengerMinterV2 id.
    #[account(
        address = cctp::TOKEN_MESSENGER_MINTER_V2_ID @ BridgeError::WrongCctpProgram,
        executable,
    )]
    pub token_messenger_minter_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: Circle PDA ["__event_authority"].
    pub event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = owner @ BridgeError::NotOwner,
    )]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptOwnership<'info> {
    pub pending_owner: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.pending_owner == Some(pending_owner.key())
            @ BridgeError::NotPendingOwner,
    )]
    pub config: Account<'info, Config>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct Bridged {
    pub nonce: [u8; 32],
    pub user: Pubkey,
    pub amount: u64,
    pub settu_fee: u64,
    pub network_fee: u64,
    pub native_fee: u64,
    pub dest_domain: u32,
    pub mint_recipient: [u8; 32],
    pub min_finality: u32,
}

#[event]
pub struct SignerUpdated {
    pub previous: Pubkey,
    pub current: Pubkey,
}

#[event]
pub struct FeeWalletUpdated {
    pub previous: Pubkey,
    pub current: Pubkey,
}

#[event]
pub struct MaxFeeBpsUpdated {
    pub previous: u16,
    pub current: u16,
}

#[event]
pub struct MaxNetworkFeeUpdated {
    pub previous: u64,
    pub current: u64,
}

#[event]
pub struct MaxNativeFeeUpdated {
    pub previous: u64,
    pub current: u64,
}

#[event]
pub struct PausedSet {
    pub owner: Pubkey,
    pub paused: bool,
}

#[event]
pub struct OwnershipTransferStarted {
    pub previous: Pubkey,
    pub pending: Pubkey,
}

#[event]
pub struct OwnershipTransferred {
    pub previous: Pubkey,
    pub current: Pubkey,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum BridgeError {
    #[msg("Bridge is paused")]
    Paused,
    #[msg("Quote expired")]
    QuoteExpired,
    #[msg("Quote is for a different user")]
    WrongUser,
    #[msg("Quote is for a different source domain")]
    WrongSourceDomain,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Settu fee above the max_fee_bps cap")]
    FeeAboveCap,
    #[msg("Network fee above max_network_fee")]
    NetworkFeeAboveMax,
    #[msg("Native fee above max_native_fee")]
    NativeFeeAboveMax,
    #[msg("Fees consume the whole amount")]
    NothingToBurn,
    #[msg("No Ed25519SigVerify instruction immediately before bridge")]
    MissingEd25519Instruction,
    #[msg("Ed25519SigVerify instruction is not a single self-contained signature")]
    MalformedEd25519Instruction,
    #[msg("Ed25519SigVerify public key is not the quote signer")]
    Ed25519SignerMismatch,
    #[msg("Ed25519SigVerify message is not this quote")]
    Ed25519MessageMismatch,
    #[msg("Basis points above 10000")]
    InvalidBps,
    #[msg("Zero address")]
    ZeroAddress,
    #[msg("Not the owner")]
    NotOwner,
    #[msg("Not the pending owner")]
    NotPendingOwner,
    #[msg("Signer is not the program upgrade authority")]
    NotUpgradeAuthority,
    #[msg("Not the configured fee wallet")]
    WrongFeeWallet,
    #[msg("Not the fee wallet's USDC associated token account")]
    WrongFeeTokenAccount,
    #[msg("Not the configured USDC mint")]
    WrongMint,
    #[msg("Not Circle's CCTP V2 program")]
    WrongCctpProgram,
}
