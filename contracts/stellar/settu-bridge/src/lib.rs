#![no_std]
#![allow(clippy::too_many_arguments)]
//! # Settu bridge (Stellar / Soroban)
//!
//! Bridges a Stellar user's USDC through Circle CCTP V2 in ONE invocation:
//! verifies a Settu-signed ed25519 quote, pays the quoted fees straight from
//! the user to Settu's fee wallet (USDC, plus optional native XLM), and burns
//! the rest through Circle's TokenMessengerMinterV2 with the user as the
//! depositor. The contract never holds funds.
//!
//! ## Circle interface (binding)
//! Source: https://github.com/circlefin/stellar-cctp, commit
//! `45746f2c803198bc6cd586475eb3c925f12bb488`:
//! - `packages/cctp-interfaces/src/token_messenger.rs`: `deposit_for_burn(caller,
//!   amount, destination_domain, mint_recipient, burn_token, destination_caller,
//!   max_fee, min_finality_threshold)` and `deposit_for_burn_with_hook(..same..,
//!   hook_data: Bytes)`.
//! - `contracts/token-messenger-minter-v2/src/contract.rs`: both call
//!   `caller.require_auth()` and the denylist check.
//! - `contracts/token-messenger-minter-v2/src/deposit.rs` (`deposit_and_burn`):
//!   `token.transfer_from(&messenger, &caller, &messenger, &local_amount)` then
//!   `token.burn(..)`. So Circle pulls from the caller through an ALLOWANCE
//!   (caller -> messenger), after normalising 7-decimal dust away (dust stays
//!   with the caller).
//!
//! ## Auth model
//! The user signs one auth entry for `bridge(user, quote, signature,
//! approve_expiration_ledger)`. Its tree covers every nested
//! `user.require_auth()`: the USDC fee `transfer`, the XLM fee `transfer`, the
//! USDC `approve(user -> messenger, burn, approve_expiration_ledger)` and
//! Circle's `deposit_for_burn[_with_hook]`. Circle's `transfer_from` needs the
//! messenger's own auth only (it is the invoker), so no separate approve
//! transaction is needed.
//!
//! `approve_expiration_ledger` is a user-chosen argument (NOT part of the
//! signed quote) because it appears verbatim in the signed auth tree: it must
//! be fixed when the wallet signs, not derived from the ledger the transaction
//! happens to land in. The contract requires
//! `current <= approve_expiration_ledger <= current + MAX_APPROVE_LEDGERS`.
//!
//! KNOWN BEHAVIOUR: the approve REPLACES any existing user -> messenger USDC
//! allowance (SEP-41 `approve` sets, it does not add). After a bridge the
//! user's allowance to Circle's TokenMessengerMinter is 0 (Circle consumes the
//! whole approval, since the burn amount is required to be dust-free).
//!
//! ## Quote message (must match `encodeQuoteBytes` in src/lib/bridge/quote.ts)
//! Big-endian: "SETTU_BRIDGE_V1" (15 ASCII) | contractId 32 | sourceDomain u32 |
//! destDomain u32 | user 32 | amount u64 | settuFee u64 | networkFee u64 |
//! nativeFee u64 | mintRecipient 32 | maxFee u64 | minFinality u32 |
//! deadline u64 | nonce 32 | hookData len u32 | hookData.
//! Pinned by `contracts/test-vectors/quotes.json` (`stellar` case).
//!
//! ## Units (Ruling J)
//! `amount`, `settu_fee`, `network_fee`, `max_fee`: Stellar USDC 7-decimal
//! units. `native_fee`: stroops. i128 on-chain, u64 in the signed message, so
//! anything negative or above u64::MAX is rejected before signing is checked.

use soroban_sdk::{
    address_payload::AddressPayload, contract, contractclient, contracterror, contractevent,
    contractimpl, contracttype, panic_with_error, token::TokenClient, Address, Bytes, BytesN,
    Env, IntoVal,
};

/// Circle's `TokenMessenger` trait, verbatim from circlefin/stellar-cctp @
/// 45746f2c803198bc6cd586475eb3c925f12bb488,
/// packages/cctp-interfaces/src/token_messenger.rs.
#[allow(clippy::too_many_arguments)]
#[contractclient(name = "TokenMessengerClient")]
pub trait TokenMessenger {
    fn deposit_for_burn(
        e: &Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    );

    fn deposit_for_burn_with_hook(
        e: &Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Bytes,
    );
}

pub const QUOTE_PREFIX: &[u8; 15] = b"SETTU_BRIDGE_V1";
pub const QUOTE_FIXED_LENGTH: u32 = 15 + 32 + 4 + 4 + 32 + 8 + 8 + 8 + 8 + 32 + 8 + 4 + 8 + 32 + 4;
pub const BPS_DENOMINATOR: i128 = 10_000;
pub const INITIAL_MAX_FEE_BPS: u32 = 100; // 1%

/// Quotes may live at most this long (server uses 120 s). Bounds how long a
/// nonce must stay readable for replay protection.
pub const MAX_QUOTE_LIFETIME_SECS: u64 = 3_600;

/// Used-nonce entries are persistent (archival never deletes them; an archived
/// entry must be restored, still present, before it can be read). We still
/// extend each one to >= ~1 day (17,280 ledgers at 5 s), which exceeds
/// MAX_QUOTE_LIFETIME_SECS even at 1 s per ledger. Networks with a larger
/// minimum persistent TTL give more.
pub const NONCE_TTL_LEDGERS: u32 = 17_280;

/// Upper bound on how far ahead the user's approve may expire (~83 min at 5 s).
pub const MAX_APPROVE_LEDGERS: u32 = 1_000;

/// 7 local decimals vs 6 canonical: Circle only burns multiples of 10.
pub const CCTP_DUST_DIVISOR: i128 = 10;

pub const INSTANCE_TTL_THRESHOLD: u32 = 17_280 * 7; // ~7 days
pub const INSTANCE_TTL_EXTEND_TO: u32 = 17_280 * 30; // ~30 days

/// Codes start at 9101 so they never collide with errors that bubble up from
/// nested calls (Stellar Asset Contract 1-13, Circle TokenMessengerMinter
/// 7100+): a nested failure must not be mistaken for one of ours.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Paused = 9101,
    QuoteExpired = 9102,
    QuoteLifetimeTooLong = 9103,
    NonceUsed = 9104,
    /// The authorising address is not a classic G-account.
    UserNotAccount = 9105,
    WrongUser = 9106,
    WrongSourceDomain = 9107,
    /// An amount is negative, out of u64 range, or `amount` is zero.
    InvalidAmount = 9108,
    FeeAboveCap = 9109,
    NetworkFeeAboveMax = 9110,
    NativeFeeAboveMax = 9111,
    /// Fees would consume the whole amount.
    NothingToBurn = 9112,
    InvalidBps = 9113,
    InvalidLimit = 9114,
    NoPendingOwner = 9115,
    /// `approve_expiration_ledger` is before the current ledger or more than
    /// MAX_APPROVE_LEDGERS after it.
    BadApproveExpiry = 9116,
    /// `amount - settu_fee - network_fee` is not a multiple of 10 (Stellar
    /// USDC has 7 decimals, CCTP 6), so Circle would leave dust behind.
    BurnAmountHasDust = 9117,
}

/// The signed quote. `user` is the raw ed25519 key of the user's G-address.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuoteArgs {
    pub source_domain: u32,
    pub dest_domain: u32,
    pub user: BytesN<32>,
    pub amount: i128,
    pub settu_fee: i128,
    pub network_fee: i128,
    pub native_fee: i128,
    pub mint_recipient: BytesN<32>,
    pub max_fee: i128,
    pub min_finality: u32,
    pub deadline: u64,
    pub nonce: BytesN<32>,
    pub hook_data: Bytes,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Owner,
    PendingOwner,
    Usdc,
    TokenMessenger,
    LocalDomain,
    Signer,
    FeeWallet,
    NativeToken,
    MaxFeeBps,
    MaxNetworkFee,
    MaxNativeFee,
    Paused,
    Nonce(BytesN<32>),
}

/// Topics `("bridged", nonce)`; data `(user, amount, settu_fee, network_fee,
/// native_fee, dest_domain, mint_recipient, min_finality)`.
#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Bridged {
    #[topic]
    pub nonce: BytesN<32>,
    pub user: Address,
    pub amount: i128,
    pub settu_fee: i128,
    pub network_fee: i128,
    pub native_fee: i128,
    pub dest_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub min_finality: u32,
}

/// Owner-setter audit trail (mirrors the EVM contract's events).
#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignerUpdated {
    pub previous: BytesN<32>,
    pub current: BytesN<32>,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeWalletUpdated {
    pub previous: Address,
    pub current: Address,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxFeeBpsUpdated {
    pub previous: u32,
    pub current: u32,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxNetworkFeeUpdated {
    pub previous: i128,
    pub current: i128,
}

#[contractevent(data_format = "vec")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxNativeFeeUpdated {
    pub previous: i128,
    pub current: i128,
}

#[contractevent(topics = ["paused"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PausedEvent {
    pub owner: Address,
}

#[contractevent(topics = ["unpaused"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UnpausedEvent {
    pub owner: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferStarted {
    #[topic]
    pub previous: Address,
    #[topic]
    pub pending: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnershipTransferred {
    #[topic]
    pub previous: Address,
    #[topic]
    pub current: Address,
}

fn u64_of(env: &Env, v: i128) -> u64 {
    if v < 0 || v > u64::MAX as i128 {
        panic_with_error!(env, Error::InvalidAmount);
    }
    v as u64
}

/// The exact bytes the Settu quote signer signs for the bridge `contract_id`.
pub fn quote_message(env: &Env, contract_id: &BytesN<32>, q: &QuoteArgs) -> Bytes {
    let mut b = Bytes::from_array(env, QUOTE_PREFIX);
    b.append(&contract_id.clone().into());
    b.extend_from_array(&q.source_domain.to_be_bytes());
    b.extend_from_array(&q.dest_domain.to_be_bytes());
    b.append(&q.user.clone().into());
    b.extend_from_array(&u64_of(env, q.amount).to_be_bytes());
    b.extend_from_array(&u64_of(env, q.settu_fee).to_be_bytes());
    b.extend_from_array(&u64_of(env, q.network_fee).to_be_bytes());
    b.extend_from_array(&u64_of(env, q.native_fee).to_be_bytes());
    b.append(&q.mint_recipient.clone().into());
    b.extend_from_array(&u64_of(env, q.max_fee).to_be_bytes());
    b.extend_from_array(&q.min_finality.to_be_bytes());
    b.extend_from_array(&q.deadline.to_be_bytes());
    b.append(&q.nonce.clone().into());
    b.extend_from_array(&q.hook_data.len().to_be_bytes());
    b.append(&q.hook_data);
    b
}

// ------------------------------------------------------------------ storage helpers

fn get<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, k: &DataKey) -> V {
    env.storage().instance().get(k).unwrap()
}

fn set<V: IntoVal<Env, soroban_sdk::Val>>(env: &Env, k: &DataKey, v: &V) {
    env.storage().instance().set(k, v);
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
}

fn require_owner(env: &Env) -> Address {
    let owner: Address = get(env, &DataKey::Owner);
    owner.require_auth();
    bump_instance(env);
    owner
}

fn check_limit(v: i128) -> Result<(), Error> {
    if v < 0 {
        return Err(Error::InvalidLimit);
    }
    Ok(())
}

fn contract_id_bytes(env: &Env) -> BytesN<32> {
    match env.current_contract_address().to_payload() {
        Some(AddressPayload::ContractIdHash(b)) => b,
        _ => panic!("contract address has no contract id"),
    }
}

// ------------------------------------------------------------------ contract

#[contract]
pub struct SettuBridge;

#[contractimpl]
impl SettuBridge {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        env: Env,
        admin: Address,
        usdc: Address,
        token_messenger: Address,
        local_domain: u32,
        signer: BytesN<32>,
        fee_wallet: Address,
        native_token: Address,
        max_network_fee: i128,
        max_native_fee: i128,
    ) -> Result<(), Error> {
        check_limit(max_network_fee)?;
        check_limit(max_native_fee)?;
        set(&env, &DataKey::Owner, &admin);
        set(&env, &DataKey::Usdc, &usdc);
        set(&env, &DataKey::TokenMessenger, &token_messenger);
        set(&env, &DataKey::LocalDomain, &local_domain);
        set(&env, &DataKey::Signer, &signer);
        set(&env, &DataKey::FeeWallet, &fee_wallet);
        set(&env, &DataKey::NativeToken, &native_token);
        set(&env, &DataKey::MaxFeeBps, &INITIAL_MAX_FEE_BPS);
        set(&env, &DataKey::MaxNetworkFee, &max_network_fee);
        set(&env, &DataKey::MaxNativeFee, &max_native_fee);
        set(&env, &DataKey::Paused, &false);
        bump_instance(&env);
        Ok(())
    }

    /// Pays the quoted fees from `user` and burns `amount - settu_fee -
    /// network_fee` through CCTP. `user` must authorise this call; that one
    /// auth tree covers all nested token and Circle calls.
    ///
    /// `approve_expiration_ledger`: expiry of the USDC approval to Circle's
    /// messenger. Chosen by the client when building the transaction (e.g.
    /// latest ledger + 100) and covered by the user's auth; must be within
    /// `[current, current + MAX_APPROVE_LEDGERS]` when the tx executes.
    pub fn bridge(
        env: Env,
        user: Address,
        quote: QuoteArgs,
        signature: BytesN<64>,
        approve_expiration_ledger: u32,
    ) -> Result<(), Error> {
        user.require_auth();
        let q = quote;

        // 1. Not paused.
        if get::<bool>(&env, &DataKey::Paused) {
            return Err(Error::Paused);
        }
        // 2. Deadline (and a bounded lifetime, so the nonce TTL always covers it).
        let now = env.ledger().timestamp();
        if now > q.deadline {
            return Err(Error::QuoteExpired);
        }
        if q.deadline - now > MAX_QUOTE_LIFETIME_SECS {
            return Err(Error::QuoteLifetimeTooLong);
        }
        // 3. Nonce unused.
        let nonce_key = DataKey::Nonce(q.nonce.clone());
        if env.storage().persistent().has(&nonce_key) {
            return Err(Error::NonceUsed);
        }
        // 4. Bound to this user and chain; amounts in range.
        match user.to_payload() {
            Some(AddressPayload::AccountIdPublicKeyEd25519(pk)) => {
                if pk != q.user {
                    return Err(Error::WrongUser);
                }
            }
            _ => return Err(Error::UserNotAccount),
        }
        if q.source_domain != get::<u32>(&env, &DataKey::LocalDomain) {
            return Err(Error::WrongSourceDomain);
        }
        let max_u64 = u64::MAX as i128;
        for v in [q.amount, q.settu_fee, q.network_fee, q.native_fee, q.max_fee] {
            if v < 0 || v > max_u64 {
                return Err(Error::InvalidAmount);
            }
        }
        if q.amount == 0 {
            return Err(Error::InvalidAmount);
        }
        // 5. Limits. Products fit: each operand < 2^64 and bps <= 2^32.
        let max_fee_bps: u32 = get(&env, &DataKey::MaxFeeBps);
        if q.settu_fee * BPS_DENOMINATOR > i128::from(max_fee_bps) * q.amount {
            return Err(Error::FeeAboveCap);
        }
        if q.network_fee > get::<i128>(&env, &DataKey::MaxNetworkFee) {
            return Err(Error::NetworkFeeAboveMax);
        }
        if q.native_fee > get::<i128>(&env, &DataKey::MaxNativeFee) {
            return Err(Error::NativeFeeAboveMax);
        }
        let usdc_fee = q.settu_fee + q.network_fee;
        if usdc_fee >= q.amount {
            return Err(Error::NothingToBurn);
        }
        let burn = q.amount - usdc_fee;
        if burn % CCTP_DUST_DIVISOR != 0 {
            return Err(Error::BurnAmountHasDust);
        }
        let seq = env.ledger().sequence();
        if approve_expiration_ledger < seq
            || approve_expiration_ledger > seq.saturating_add(MAX_APPROVE_LEDGERS)
        {
            return Err(Error::BadApproveExpiry);
        }
        // 6. Signature (host traps on failure).
        let signer: BytesN<32> = get(&env, &DataKey::Signer);
        let msg = quote_message(&env, &contract_id_bytes(&env), &q);
        env.crypto().ed25519_verify(&signer, &msg, &signature);

        // Effects.
        env.storage().persistent().set(&nonce_key, &true);
        env.storage()
            .persistent()
            .extend_ttl(&nonce_key, NONCE_TTL_LEDGERS, NONCE_TTL_LEDGERS);
        bump_instance(&env);

        // 7. Fees, user -> fee wallet.
        let usdc_addr: Address = get(&env, &DataKey::Usdc);
        let usdc = TokenClient::new(&env, &usdc_addr);
        let fee_wallet: Address = get(&env, &DataKey::FeeWallet);
        if usdc_fee > 0 {
            usdc.transfer(&user, &fee_wallet, &usdc_fee);
        }
        if q.native_fee > 0 {
            let native: Address = get(&env, &DataKey::NativeToken);
            TokenClient::new(&env, &native).transfer(&user, &fee_wallet, &q.native_fee);
        }

        // 8. Burn the rest: approve Circle's messenger for exactly the burn
        // amount, then deposit with the user as caller. Circle pulls it with
        // transfer_from (see module docs).
        // KNOWN BEHAVIOUR: this REPLACES any existing user -> messenger
        // allowance; afterwards it is 0 (Circle consumes the dust-free burn).
        let messenger: Address = get(&env, &DataKey::TokenMessenger);
        usdc.approve(&user, &messenger, &burn, &approve_expiration_ledger);
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let tmm = TokenMessengerClient::new(&env, &messenger);
        if q.hook_data.is_empty() {
            tmm.deposit_for_burn(
                &user, &burn, &q.dest_domain, &q.mint_recipient, &usdc_addr, &zero, &q.max_fee,
                &q.min_finality,
            );
        } else {
            // Circle rejects empty hook data on this entry point (HookDataEmpty).
            tmm.deposit_for_burn_with_hook(
                &user, &burn, &q.dest_domain, &q.mint_recipient, &usdc_addr, &zero, &q.max_fee,
                &q.min_finality, &q.hook_data,
            );
        }

        // 9. Event.
        Bridged {
            nonce: q.nonce,
            user,
            amount: q.amount,
            settu_fee: q.settu_fee,
            network_fee: q.network_fee,
            native_fee: q.native_fee,
            dest_domain: q.dest_domain,
            mint_recipient: q.mint_recipient,
            min_finality: q.min_finality,
        }
        .publish(&env);
        Ok(())
    }

    // -------------------------------------------------------------- owner

    pub fn set_signer(env: Env, signer: BytesN<32>) -> Result<(), Error> {
        require_owner(&env);
        let previous: BytesN<32> = get(&env, &DataKey::Signer);
        set(&env, &DataKey::Signer, &signer);
        SignerUpdated { previous, current: signer }.publish(&env);
        Ok(())
    }

    pub fn set_fee_wallet(env: Env, fee_wallet: Address) -> Result<(), Error> {
        require_owner(&env);
        let previous: Address = get(&env, &DataKey::FeeWallet);
        set(&env, &DataKey::FeeWallet, &fee_wallet);
        FeeWalletUpdated { previous, current: fee_wallet }.publish(&env);
        Ok(())
    }

    pub fn set_max_fee_bps(env: Env, bps: u32) -> Result<(), Error> {
        require_owner(&env);
        if i128::from(bps) > BPS_DENOMINATOR {
            return Err(Error::InvalidBps);
        }
        let previous: u32 = get(&env, &DataKey::MaxFeeBps);
        set(&env, &DataKey::MaxFeeBps, &bps);
        MaxFeeBpsUpdated { previous, current: bps }.publish(&env);
        Ok(())
    }

    pub fn set_max_network_fee(env: Env, v: i128) -> Result<(), Error> {
        require_owner(&env);
        check_limit(v)?;
        let previous: i128 = get(&env, &DataKey::MaxNetworkFee);
        set(&env, &DataKey::MaxNetworkFee, &v);
        MaxNetworkFeeUpdated { previous, current: v }.publish(&env);
        Ok(())
    }

    pub fn set_max_native_fee(env: Env, v: i128) -> Result<(), Error> {
        require_owner(&env);
        check_limit(v)?;
        let previous: i128 = get(&env, &DataKey::MaxNativeFee);
        set(&env, &DataKey::MaxNativeFee, &v);
        MaxNativeFeeUpdated { previous, current: v }.publish(&env);
        Ok(())
    }

    pub fn pause(env: Env) -> Result<(), Error> {
        let owner = require_owner(&env);
        set(&env, &DataKey::Paused, &true);
        PausedEvent { owner }.publish(&env);
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), Error> {
        let owner = require_owner(&env);
        set(&env, &DataKey::Paused, &false);
        UnpausedEvent { owner }.publish(&env);
        Ok(())
    }

    /// Step 1 of 2: nominate `new_owner`. Re-nominating replaces the pending one.
    pub fn transfer_ownership(env: Env, new_owner: Address) -> Result<(), Error> {
        let previous = require_owner(&env);
        set(&env, &DataKey::PendingOwner, &new_owner);
        OwnershipTransferStarted { previous, pending: new_owner }.publish(&env);
        Ok(())
    }

    /// Step 2 of 2: the nominee accepts.
    pub fn accept_ownership(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingOwner)
            .ok_or(Error::NoPendingOwner)?;
        pending.require_auth();
        let previous: Address = get(&env, &DataKey::Owner);
        set(&env, &DataKey::Owner, &pending);
        OwnershipTransferred { previous, current: pending }.publish(&env);
        env.storage().instance().remove(&DataKey::PendingOwner);
        bump_instance(&env);
        Ok(())
    }

    // -------------------------------------------------------------- views

    pub fn owner(env: Env) -> Address {
        get(&env, &DataKey::Owner)
    }
    pub fn pending_owner(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingOwner)
    }
    pub fn usdc(env: Env) -> Address {
        get(&env, &DataKey::Usdc)
    }
    pub fn token_messenger(env: Env) -> Address {
        get(&env, &DataKey::TokenMessenger)
    }
    pub fn native_token(env: Env) -> Address {
        get(&env, &DataKey::NativeToken)
    }
    pub fn local_domain(env: Env) -> u32 {
        get(&env, &DataKey::LocalDomain)
    }
    pub fn signer(env: Env) -> BytesN<32> {
        get(&env, &DataKey::Signer)
    }
    pub fn fee_wallet(env: Env) -> Address {
        get(&env, &DataKey::FeeWallet)
    }
    pub fn max_fee_bps(env: Env) -> u32 {
        get(&env, &DataKey::MaxFeeBps)
    }
    pub fn max_network_fee(env: Env) -> i128 {
        get(&env, &DataKey::MaxNetworkFee)
    }
    pub fn max_native_fee(env: Env) -> i128 {
        get(&env, &DataKey::MaxNativeFee)
    }
    pub fn paused(env: Env) -> bool {
        get(&env, &DataKey::Paused)
    }
    pub fn is_nonce_used(env: Env, nonce: BytesN<32>) -> bool {
        env.storage().persistent().has(&DataKey::Nonce(nonce))
    }
}

#[cfg(test)]
mod test;
