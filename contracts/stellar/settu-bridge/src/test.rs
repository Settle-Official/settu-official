#![cfg(test)]
#![allow(clippy::inconsistent_digit_grouping)]
extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey, Verifier as _, VerifyingKey};
use soroban_sdk::{
    address_payload::AddressPayload,
    contract, contractimpl, contracttype,
    testutils::{
        storage::Persistent as _, Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _,
        MockAuth, MockAuthInvoke,
    },
    token, xdr, Address, Bytes, BytesN, Env, Event as _, IntoVal, Symbol, TryFromVal,
};
use std::borrow::ToOwned;
use std::rc::Rc;
use std::vec::Vec as StdVec;

// ------------------------------------------------------------------ mock messenger

/// One recorded `deposit_for_burn[_with_hook]` call.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnCall {
    pub caller: Address,
    pub amount: i128,
    pub burned: i128,
    pub destination_domain: u32,
    pub mint_recipient: BytesN<32>,
    pub burn_token: Address,
    pub destination_caller: BytesN<32>,
    pub max_fee: i128,
    pub min_finality_threshold: u32,
    pub hook_data: Bytes,
    pub with_hook: bool,
}

/// Mirrors Circle's Stellar TokenMessengerMinterV2 entry points and funds flow
/// (circlefin/stellar-cctp @ 45746f2c, contracts/token-messenger-minter-v2/src/
/// contract.rs + deposit.rs): `caller.require_auth()`, then dust-normalise the
/// 7-decimal amount to 6 decimals, then
/// `token.transfer_from(&self, &caller, &self, &local)` + `token.burn(&self, &local)`.
/// `transfer_from` needs an allowance caller -> messenger, exactly as on mainnet.
#[contract]
pub struct MockTokenMessenger;

#[contractimpl]
impl MockTokenMessenger {
    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn(
        e: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
    ) {
        let hook = Bytes::new(&e);
        record(
            &e, caller, amount, destination_domain, mint_recipient, burn_token,
            destination_caller, max_fee, min_finality_threshold, hook, false,
        );
    }

    #[allow(clippy::too_many_arguments)]
    pub fn deposit_for_burn_with_hook(
        e: Env,
        caller: Address,
        amount: i128,
        destination_domain: u32,
        mint_recipient: BytesN<32>,
        burn_token: Address,
        destination_caller: BytesN<32>,
        max_fee: i128,
        min_finality_threshold: u32,
        hook_data: Bytes,
    ) {
        record(
            &e, caller, amount, destination_domain, mint_recipient, burn_token,
            destination_caller, max_fee, min_finality_threshold, hook_data, true,
        );
    }

    pub fn calls(e: Env) -> soroban_sdk::Vec<BurnCall> {
        e.storage()
            .instance()
            .get(&Symbol::new(&e, "calls"))
            .unwrap_or(soroban_sdk::Vec::new(&e))
    }
}

#[allow(clippy::too_many_arguments)]
fn record(
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
    with_hook: bool,
) {
    caller.require_auth();
    assert!(amount > 0, "AmountMustBeNonzero");
    assert!(max_fee >= 0, "MaxFeeMustBeNonNegative");
    // 7 local decimals -> 6 canonical: dust (amount % 10) stays with the caller.
    let local = amount - amount % 10;
    assert!(local > 0, "BurnAmountTooSmall");
    let me = e.current_contract_address();
    let t = token::Client::new(e, &burn_token);
    t.transfer_from(&me, &caller, &me, &local);
    t.burn(&me, &local);
    let mut calls = MockTokenMessenger::calls(e.clone());
    calls.push_back(BurnCall {
        caller, amount, burned: local, destination_domain, mint_recipient, burn_token,
        destination_caller, max_fee, min_finality_threshold, hook_data, with_hook,
    });
    e.storage().instance().set(&Symbol::new(e, "calls"), &calls);
}

// ------------------------------------------------------------------ ledger helpers

fn account_id(pk: [u8; 32]) -> xdr::AccountId {
    xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(pk)))
}

/// Creates a classic G-account (XLM balance in stroops) and returns its Address.
fn create_account(env: &Env, pk: [u8; 32], stroops: i64) -> Address {
    let id = account_id(pk);
    let k = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount { account_id: id.clone() }));
    let v = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id: id,
            balance: stroops,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 0,
            seq_num: xdr::SequenceNumber(0),
            thresholds: xdr::Thresholds([1; 4]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&k, &v, None).unwrap();
    AddressPayload::AccountIdPublicKeyEd25519(BytesN::from_array(env, &pk)).to_address(env)
}

/// Adds an authorised, empty trustline for a credit asset.
fn create_trustline(env: &Env, pk: [u8; 32], asset: &xdr::Asset) {
    let tl_asset = match asset {
        xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a.clone()),
        xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a.clone()),
        xdr::Asset::Native => panic!("native has no trustline"),
    };
    let k = Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
        account_id: account_id(pk),
        asset: tl_asset.clone(),
    }));
    let v = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
            account_id: account_id(pk),
            asset: tl_asset,
            balance: 0,
            limit: i64::MAX,
            flags: xdr::TrustLineFlags::AuthorizedFlag as u32,
            ext: xdr::TrustLineEntryExt::V0,
        }),
        last_modified_ledger_seq: 0,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&k, &v, None).unwrap();
}

/// Deploys the real built-in Stellar Asset Contract for native XLM.
fn register_native_sac(env: &Env) -> Address {
    let create = xdr::HostFunction::CreateContract(xdr::CreateContractArgs {
        contract_id_preimage: xdr::ContractIdPreimage::Asset(xdr::Asset::Native),
        executable: xdr::ContractExecutable::StellarAsset,
    });
    let v = env.host().invoke_function(create).unwrap();
    Address::try_from_val(env, &v).unwrap()
}

// ------------------------------------------------------------------ fixture

const LOCAL: u32 = 27;
const NOW: u64 = 1_700_000_000;
const MAX_NETWORK_FEE: i128 = 10_000_000; // 1 USDC (7 dp)
const MAX_NATIVE_FEE: i128 = 50_000_000; // 5 XLM in stroops
const USER_USDC: i128 = 10_000_0000000; // 10,000 USDC
const USER_XLM: i64 = 1_000_0000000; // 1,000 XLM
const USER_PK: [u8; 32] = [0x33; 32];
const FEE_PK: [u8; 32] = [0x55; 32];
const OTHER_PK: [u8; 32] = [0x66; 32];
const SIGNER_SEED: [u8; 32] = [0x42; 32];

struct T {
    env: Env,
    id: Address,
    bridge: SettuBridgeClient<'static>,
    owner: Address,
    user: Address,
    fee_wallet: Address,
    usdc_sac: Address,
    usdc: token::Client<'static>,
    usdc_admin: token::StellarAssetClient<'static>,
    usdc_asset: xdr::Asset,
    xlm: token::Client<'static>,
    messenger: MockTokenMessengerClient<'static>,
    sk: SigningKey,
}

fn setup() -> T {
    setup_at(None, SigningKey::from_bytes(&SIGNER_SEED), USER_PK)
}

fn setup_at(contract_id: Option<Address>, sk: SigningKey, user_pk: [u8; 32]) -> T {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| {
        l.timestamp = NOW;
        l.sequence_number = 1_000;
    });

    let usdc_issuer_admin = Address::generate(&env);
    let usdc_contract = env.register_stellar_asset_contract_v2(usdc_issuer_admin);
    let usdc_sac = usdc_contract.address();
    let usdc_asset = usdc_contract.asset();
    let native = register_native_sac(&env);

    let user = create_account(&env, user_pk, USER_XLM);
    create_trustline(&env, user_pk, &usdc_asset);
    let fee_wallet = create_account(&env, FEE_PK, 10_0000000);
    create_trustline(&env, FEE_PK, &usdc_asset);
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_sac);
    usdc_admin.mint(&user, &USER_USDC);

    let messenger_id = env.register(MockTokenMessenger, ());
    let owner = Address::generate(&env);
    let signer = BytesN::from_array(&env, &sk.verifying_key().to_bytes());
    let args = (
        owner.clone(),
        usdc_sac.clone(),
        messenger_id.clone(),
        LOCAL,
        signer,
        fee_wallet.clone(),
        native.clone(),
        MAX_NETWORK_FEE,
        MAX_NATIVE_FEE,
    );
    let id = match contract_id {
        Some(at) => env.register_at(&at, SettuBridge, args),
        None => env.register(SettuBridge, args),
    };

    T {
        bridge: SettuBridgeClient::new(&env, &id),
        usdc: token::Client::new(&env, &usdc_sac),
        usdc_admin,
        xlm: token::Client::new(&env, &native),
        messenger: MockTokenMessengerClient::new(&env, &messenger_id),
        id,
        owner,
        user,
        fee_wallet,
        usdc_sac,
        usdc_asset,
        sk,
        env,
    }
}

impl T {
    fn quote(&self) -> QuoteArgs {
        QuoteArgs {
            source_domain: LOCAL,
            dest_domain: 6,
            user: match self.user.to_payload().unwrap() {
                AddressPayload::AccountIdPublicKeyEd25519(pk) => pk,
                _ => unreachable!(),
            },
            amount: 1_000_0000000,     // 1,000 USDC
            settu_fee: 5_000_000,       // 0.5 USDC (5 bps)
            network_fee: 2_000_000,     // 0.2 USDC
            native_fee: 0,
            mint_recipient: BytesN::from_array(&self.env, &[0xab; 32]),
            max_fee: 1_000,
            min_finality: 2000,
            deadline: NOW + 120,
            nonce: BytesN::from_array(&self.env, &[0x01; 32]),
            hook_data: Bytes::new(&self.env),
        }
    }

    fn contract_id_bytes(&self) -> BytesN<32> {
        match self.id.to_payload().unwrap() {
            AddressPayload::ContractIdHash(b) => b,
            _ => panic!("not a contract"),
        }
    }

    fn sign(&self, q: &QuoteArgs) -> BytesN<64> {
        let msg: StdVec<u8> = quote_message(&self.env, &self.contract_id_bytes(), q).iter().collect();
        BytesN::from_array(&self.env, &self.sk.sign(&msg).to_bytes())
    }

    fn bridge_ok(&self, q: &QuoteArgs) {
        let sig = self.sign(q);
        self.bridge.bridge(&self.user, q, &sig);
    }

    fn try_bridge(&self, q: &QuoteArgs, sig: &BytesN<64>) -> Result<(), BridgeErr> {
        match self.bridge.try_bridge(&self.user, q, sig) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => unreachable!(),
            Err(Ok(e)) => Err(BridgeErr::Contract(e)),
            Err(Err(_)) => Err(BridgeErr::Host),
        }
    }

    fn expect_err(&self, q: &QuoteArgs, err: Error) {
        let sig = self.sign(q);
        assert_eq!(self.try_bridge(q, &sig), Err(BridgeErr::Contract(err)));
        self.assert_untouched(q);
    }

    /// Host-level failure (signature, token, auth): not a contract error code.
    fn expect_host_err(&self, q: &QuoteArgs, sig: &BytesN<64>) {
        assert_eq!(self.try_bridge(q, sig), Err(BridgeErr::Host));
        self.assert_untouched(q);
    }

    fn assert_untouched(&self, q: &QuoteArgs) {
        assert_eq!(self.usdc.balance(&self.user), USER_USDC);
        assert_eq!(self.xlm.balance(&self.user), USER_XLM as i128);
        assert!(!self.bridge.is_nonce_used(&q.nonce));
        assert_eq!(self.messenger.calls().len(), 0);
    }

    fn zero_balances(&self) {
        assert_eq!(self.usdc.balance(&self.id), 0);
        assert_eq!(self.xlm.balance(&self.id), 0);
        assert_eq!(self.usdc.balance(&self.messenger.address), 0);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum BridgeErr {
    Contract(Error),
    Host,
}

// ------------------------------------------------------------------ initial state

#[test]
fn initial_state() {
    let t = setup();
    assert_eq!(t.bridge.owner(), t.owner);
    assert_eq!(t.bridge.pending_owner(), None);
    assert_eq!(t.bridge.usdc(), t.usdc_sac);
    assert_eq!(t.bridge.token_messenger(), t.messenger.address);
    assert_eq!(t.bridge.native_token(), t.xlm.address);
    assert_eq!(t.bridge.local_domain(), LOCAL);
    assert_eq!(t.bridge.signer().to_array(), t.sk.verifying_key().to_bytes());
    assert_eq!(t.bridge.fee_wallet(), t.fee_wallet);
    assert_eq!(t.bridge.max_fee_bps(), 100);
    assert_eq!(t.bridge.max_network_fee(), MAX_NETWORK_FEE);
    assert_eq!(t.bridge.max_native_fee(), MAX_NATIVE_FEE);
    assert!(!t.bridge.paused());
}

#[test]
fn constructor_rejects_negative_limits() {
    let env = Env::default();
    let a = Address::generate(&env);
    let signer = BytesN::from_array(&env, &[1; 32]);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(
            SettuBridge,
            (a.clone(), a.clone(), a.clone(), LOCAL, signer.clone(), a.clone(), a.clone(), -1i128, 0i128),
        )
    }));
    assert!(r.is_err());
}

// ------------------------------------------------------------------ happy paths

#[test]
fn usdc_mode_moves_exact_fees_and_burns_rest() {
    let t = setup();
    let q = t.quote();
    let fee_xlm_before = t.xlm.balance(&t.fee_wallet);
    let supply_note = t.usdc.balance(&t.user);
    t.bridge_ok(&q);

    let usdc_fee = q.settu_fee + q.network_fee;
    let burn = q.amount - usdc_fee;
    assert_eq!(t.usdc.balance(&t.user), supply_note - q.amount);
    assert_eq!(t.usdc.balance(&t.fee_wallet), usdc_fee);
    assert_eq!(t.xlm.balance(&t.fee_wallet), fee_xlm_before);
    assert_eq!(t.xlm.balance(&t.user), USER_XLM as i128);
    t.zero_balances();
    assert!(t.bridge.is_nonce_used(&q.nonce));

    let calls = t.messenger.calls();
    assert_eq!(calls.len(), 1);
    let c = calls.get(0).unwrap();
    assert_eq!(
        c,
        BurnCall {
            caller: t.user.clone(),
            amount: burn,
            burned: burn,
            destination_domain: q.dest_domain,
            mint_recipient: q.mint_recipient.clone(),
            burn_token: t.usdc_sac.clone(),
            destination_caller: BytesN::from_array(&t.env, &[0; 32]),
            max_fee: q.max_fee,
            min_finality_threshold: q.min_finality,
            hook_data: Bytes::new(&t.env),
            with_hook: false,
        }
    );
    // The approval is consumed exactly; nothing lingers.
    assert_eq!(t.usdc.allowance(&t.user, &t.messenger.address), 0);
}

#[test]
fn native_mode_moves_exact_native_fee() {
    let t = setup();
    let mut q = t.quote();
    q.network_fee = 0;
    q.native_fee = 12_345_678; // ~1.23 XLM
    let fee_xlm_before = t.xlm.balance(&t.fee_wallet);
    t.bridge_ok(&q);

    assert_eq!(t.xlm.balance(&t.fee_wallet), fee_xlm_before + q.native_fee);
    assert_eq!(t.xlm.balance(&t.user), USER_XLM as i128 - q.native_fee);
    assert_eq!(t.usdc.balance(&t.fee_wallet), q.settu_fee);
    assert_eq!(t.usdc.balance(&t.user), USER_USDC - q.amount);
    let c = t.messenger.calls().get(0).unwrap();
    assert_eq!(c.amount, q.amount - q.settu_fee);
    t.zero_balances();
}

#[test]
fn hook_data_uses_deposit_for_burn_with_hook() {
    let t = setup();
    let mut q = t.quote();
    q.hook_data = Bytes::from_array(&t.env, &[0xde, 0xad, 0xbe, 0xef]);
    t.bridge_ok(&q);
    let c = t.messenger.calls().get(0).unwrap();
    assert!(c.with_hook);
    assert_eq!(c.hook_data, q.hook_data);
    assert_eq!(c.amount, q.amount - q.settu_fee - q.network_fee);
    t.zero_balances();
}

#[test]
fn zero_fees_burns_whole_amount() {
    let t = setup();
    let mut q = t.quote();
    q.settu_fee = 0;
    q.network_fee = 0;
    t.bridge_ok(&q);
    assert_eq!(t.usdc.balance(&t.fee_wallet), 0);
    assert_eq!(t.messenger.calls().get(0).unwrap().amount, q.amount);
    t.zero_balances();
}

#[test]
fn dust_below_cctp_precision_stays_with_user() {
    let t = setup();
    let mut q = t.quote();
    q.settu_fee = 5_000_003; // burn amount ends in ...7: 7 dust units
    t.bridge_ok(&q);
    let burn = q.amount - q.settu_fee - q.network_fee;
    let c = t.messenger.calls().get(0).unwrap();
    assert_eq!(c.amount, burn);
    assert_eq!(c.burned, burn - 7);
    assert_eq!(t.usdc.balance(&t.user), USER_USDC - q.amount + 7);
    t.zero_balances();
}

#[test]
fn fee_exactly_at_cap_passes() {
    let t = setup();
    let mut q = t.quote();
    q.settu_fee = q.amount / 100; // exactly 1%
    t.bridge_ok(&q);
    assert_eq!(t.usdc.balance(&t.fee_wallet), q.settu_fee + q.network_fee);
}

#[test]
fn limits_exactly_at_max_pass() {
    let t = setup();
    let mut q = t.quote();
    q.network_fee = MAX_NETWORK_FEE;
    q.native_fee = MAX_NATIVE_FEE;
    t.bridge_ok(&q);
}

#[test]
fn deadline_equal_to_now_passes() {
    let t = setup();
    let mut q = t.quote();
    q.deadline = NOW;
    t.bridge_ok(&q);
}

#[test]
fn emits_bridged_event() {
    let t = setup();
    let mut q = t.quote();
    q.native_fee = 7;
    t.bridge_ok(&q);
    let expected = Bridged {
        nonce: q.nonce.clone(),
        user: t.user.clone(),
        amount: q.amount,
        settu_fee: q.settu_fee,
        network_fee: q.network_fee,
        native_fee: q.native_fee,
        dest_domain: q.dest_domain,
        mint_recipient: q.mint_recipient.clone(),
        min_finality: q.min_finality,
    };
    let mine: StdVec<(Address, soroban_sdk::Vec<soroban_sdk::Val>, soroban_sdk::Val)> = t
        .env
        .events()
        .all()
        .iter()
        .filter(|(c, _, _)| *c == t.id)
        .collect();
    assert_eq!(mine.len(), 1);
    let (_, topics, data) = mine[0].clone();
    // Topic layout the indexer relies on: ("bridged", nonce); data is a vec.
    let want_topics: soroban_sdk::Vec<soroban_sdk::Val> =
        (Symbol::new(&t.env, "bridged"), q.nonce.clone()).into_val(&t.env);
    assert_eq!(topics, want_topics);
    let want_data: soroban_sdk::Val = (
        t.user.clone(),
        q.amount,
        q.settu_fee,
        q.network_fee,
        q.native_fee,
        q.dest_domain,
        q.mint_recipient.clone(),
        q.min_finality,
    )
        .into_val(&t.env);
    let got = soroban_sdk::Vec::<soroban_sdk::Val>::try_from_val(&t.env, &data).unwrap();
    let want = soroban_sdk::Vec::<soroban_sdk::Val>::try_from_val(&t.env, &want_data).unwrap();
    assert_eq!(got, want);
    // And the typed event struct produces the same topics/data.
    assert_eq!(expected.topics(&t.env), want_topics);
}

// ------------------------------------------------------------------ auth model

/// One user signature: the user authorises `bridge`, and that one tree covers
/// the fee transfer(s), the USDC approval to Circle's messenger and the nested
/// `deposit_for_burn`. No prior approve transaction is needed.
#[test]
fn single_user_auth_tree_covers_all_nested_calls() {
    let t = setup();
    let mut q = t.quote();
    q.native_fee = 1_000;
    assert_eq!(t.usdc.allowance(&t.user, &t.messenger.address), 0);
    let sig = t.sign(&q);
    t.bridge.bridge(&t.user, &q, &sig);

    let usdc_fee = q.settu_fee + q.network_fee;
    let burn = q.amount - usdc_fee;
    let seq = t.env.ledger().sequence();
    let zero = BytesN::from_array(&t.env, &[0; 32]);
    let auths = t.env.auths();
    assert_eq!(
        auths,
        std::vec![(
            t.user.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    t.id.clone(),
                    Symbol::new(&t.env, "bridge"),
                    (t.user.clone(), q.clone(), sig.clone()).into_val(&t.env),
                )),
                sub_invocations: std::vec![
                    AuthorizedInvocation {
                        function: AuthorizedFunction::Contract((
                            t.usdc_sac.clone(),
                            Symbol::new(&t.env, "transfer"),
                            (t.user.clone(), t.fee_wallet.clone(), usdc_fee).into_val(&t.env),
                        )),
                        sub_invocations: std::vec![],
                    },
                    AuthorizedInvocation {
                        function: AuthorizedFunction::Contract((
                            t.xlm.address.clone(),
                            Symbol::new(&t.env, "transfer"),
                            (t.user.clone(), t.fee_wallet.clone(), q.native_fee).into_val(&t.env),
                        )),
                        sub_invocations: std::vec![],
                    },
                    AuthorizedInvocation {
                        function: AuthorizedFunction::Contract((
                            t.usdc_sac.clone(),
                            Symbol::new(&t.env, "approve"),
                            (t.user.clone(), t.messenger.address.clone(), burn, seq).into_val(&t.env),
                        )),
                        sub_invocations: std::vec![],
                    },
                    AuthorizedInvocation {
                        function: AuthorizedFunction::Contract((
                            t.messenger.address.clone(),
                            Symbol::new(&t.env, "deposit_for_burn"),
                            (
                                t.user.clone(),
                                burn,
                                q.dest_domain,
                                q.mint_recipient.clone(),
                                t.usdc_sac.clone(),
                                zero,
                                q.max_fee,
                                q.min_finality,
                            )
                                .into_val(&t.env),
                        )),
                        sub_invocations: std::vec![],
                    },
                ],
            }
        )]
    );
}

// Real (non-mocked) classic-account auth: the user's ed25519 key signs a
// SorobanAuthorizationEntry exactly as a wallet would.

fn scval<V: IntoVal<Env, soroban_sdk::Val>>(env: &Env, v: V) -> xdr::ScVal {
    xdr::ScVal::try_from_val(env, &v.into_val(env)).unwrap()
}

fn sc_address(env: &Env, a: &Address) -> xdr::ScAddress {
    match scval(env, a.clone()) {
        xdr::ScVal::Address(a) => a,
        _ => unreachable!(),
    }
}

fn inv(
    env: &Env,
    contract: &Address,
    fn_name: &str,
    args: soroban_sdk::Vec<soroban_sdk::Val>,
    subs: StdVec<xdr::SorobanAuthorizedInvocation>,
) -> xdr::SorobanAuthorizedInvocation {
    let args: StdVec<xdr::ScVal> = args.iter().map(|v| scval(env, v)).collect();
    xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: sc_address(env, contract),
            function_name: xdr::ScSymbol(fn_name.try_into().unwrap()),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: subs.try_into().unwrap(),
    }
}

fn signed_entry(
    env: &Env,
    sk: &SigningKey,
    user: &Address,
    nonce: i64,
    root: xdr::SorobanAuthorizedInvocation,
) -> xdr::SorobanAuthorizationEntry {
    use xdr::WriteXdr as _;
    let exp = env.ledger().sequence() + 100;
    let preimage = xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(env.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: exp,
        invocation: root.clone(),
    });
    let payload = env
        .crypto()
        .sha256(&Bytes::from_slice(env, &preimage.to_xdr(xdr::Limits::none()).unwrap()))
        .to_array();
    let sig = sk.sign(&payload).to_bytes();
    let pk = sk.verifying_key().to_bytes();
    let sig_map = xdr::ScVal::Map(Some(
        std::vec![
            xdr::ScMapEntry {
                key: xdr::ScVal::Symbol(xdr::ScSymbol("public_key".try_into().unwrap())),
                val: xdr::ScVal::Bytes(xdr::ScBytes(pk.to_vec().try_into().unwrap())),
            },
            xdr::ScMapEntry {
                key: xdr::ScVal::Symbol(xdr::ScSymbol("signature".try_into().unwrap())),
                val: xdr::ScVal::Bytes(xdr::ScBytes(sig.to_vec().try_into().unwrap())),
            },
        ]
        .try_into()
        .unwrap(),
    ));
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: sc_address(env, user),
            nonce,
            signature_expiration_ledger: exp,
            signature: xdr::ScVal::Vec(Some(std::vec![sig_map].try_into().unwrap())),
        }),
        root_invocation: root,
    }
}

fn real_auth_fixture() -> (T, SigningKey) {
    let user_sk = SigningKey::from_bytes(&[0x21; 32]);
    let t = setup_at(None, SigningKey::from_bytes(&SIGNER_SEED), user_sk.verifying_key().to_bytes());
    (t, user_sk)
}

fn full_tree(t: &T, q: &QuoteArgs, sig: &BytesN<64>) -> xdr::SorobanAuthorizedInvocation {
    let e = &t.env;
    let usdc_fee = q.settu_fee + q.network_fee;
    let burn = q.amount - usdc_fee;
    let zero = BytesN::from_array(e, &[0; 32]);
    inv(
        e,
        &t.id,
        "bridge",
        (t.user.clone(), q.clone(), sig.clone()).into_val(e),
        std::vec![
            inv(e, &t.usdc_sac, "transfer", (t.user.clone(), t.fee_wallet.clone(), usdc_fee).into_val(e), std::vec![]),
            inv(e, &t.xlm.address, "transfer", (t.user.clone(), t.fee_wallet.clone(), q.native_fee).into_val(e), std::vec![]),
            inv(e, &t.usdc_sac, "approve", (t.user.clone(), t.messenger.address.clone(), burn, e.ledger().sequence()).into_val(e), std::vec![]),
            inv(
                e,
                &t.messenger.address,
                "deposit_for_burn",
                (t.user.clone(), burn, q.dest_domain, q.mint_recipient.clone(), t.usdc_sac.clone(), zero, q.max_fee, q.min_finality).into_val(e),
                std::vec![],
            ),
        ],
    )
}

/// One real signature by the user's account key, over one auth tree, is
/// enough for the whole bridge: fee transfers, approve and Circle's burn.
#[test]
fn real_user_signature_over_one_tree_is_sufficient() {
    let (t, user_sk) = real_auth_fixture();
    let mut q = t.quote();
    q.native_fee = 1_000;
    let sig = t.sign(&q);
    let entry = signed_entry(&t.env, &user_sk, &t.user, 1, full_tree(&t, &q, &sig));
    t.env.set_auths(&[entry]);
    t.bridge.bridge(&t.user, &q, &sig);
    assert_eq!(t.usdc.balance(&t.user), USER_USDC - q.amount);
    assert_eq!(t.messenger.calls().len(), 1);
    t.zero_balances();
}

/// A tree that authorises only the root call (no nested calls) is rejected,
/// as is no auth at all, or a signature by a key other than the user's.
#[test]
fn bridge_without_full_user_auth_fails() {
    let (t, user_sk) = real_auth_fixture();
    let q = t.quote();
    let sig = t.sign(&q);
    let e = &t.env;

    e.set_auths(&[]);
    assert_eq!(t.try_bridge(&q, &sig), Err(BridgeErr::Host));

    let root_only = inv(e, &t.id, "bridge", (t.user.clone(), q.clone(), sig.clone()).into_val(e), std::vec![]);
    e.set_auths(&[signed_entry(e, &user_sk, &t.user, 2, root_only)]);
    assert_eq!(t.try_bridge(&q, &sig), Err(BridgeErr::Host));

    let impostor = SigningKey::from_bytes(&[0x22; 32]);
    e.set_auths(&[signed_entry(e, &impostor, &t.user, 3, full_tree(&t, &q, &sig))]);
    assert_eq!(t.try_bridge(&q, &sig), Err(BridgeErr::Host));

    e.mock_all_auths();
    t.assert_untouched(&q);
}

#[test]
fn prior_allowance_is_not_required_and_does_not_linger() {
    let t = setup();
    // A stale large allowance (e.g. from the offramp flow) is replaced by the
    // exact burn amount, consumed, and expires this ledger.
    let seq = t.env.ledger().sequence();
    t.usdc.approve(&t.user, &t.messenger.address, &999_0000000, &(seq + 100));
    t.bridge_ok(&t.quote());
    assert_eq!(t.usdc.allowance(&t.user, &t.messenger.address), 0);
}

// ------------------------------------------------------------------ reverts: native

#[test]
fn revert_native_fee_tampered_after_signing() {
    let t = setup();
    let mut q = t.quote();
    q.native_fee = 1_000_000;
    let sig = t.sign(&q);
    q.native_fee = 2_000_000; // user (or a relayer) tries to pay a different amount
    t.expect_host_err(&q, &sig);
    q.native_fee = 0;
    t.expect_host_err(&q, &sig);
}

#[test]
fn revert_native_fee_exceeds_user_balance() {
    let t = setup();
    t.bridge.set_max_native_fee(&(USER_XLM as i128 * 2));
    let mut q = t.quote();
    q.native_fee = USER_XLM as i128 + 1;
    let sig = t.sign(&q);
    t.expect_host_err(&q, &sig);
}

#[test]
fn revert_network_fee_above_max() {
    let t = setup();
    let mut q = t.quote();
    q.network_fee = MAX_NETWORK_FEE + 1;
    t.expect_err(&q, Error::NetworkFeeAboveMax);
}

#[test]
fn revert_native_fee_above_max() {
    let t = setup();
    let mut q = t.quote();
    q.native_fee = MAX_NATIVE_FEE + 1;
    t.expect_err(&q, Error::NativeFeeAboveMax);
}

// ------------------------------------------------------------------ reverts: quote

#[test]
fn revert_expired() {
    let t = setup();
    let mut q = t.quote();
    q.deadline = NOW - 1;
    t.expect_err(&q, Error::QuoteExpired);
}

#[test]
fn revert_quote_lifetime_too_long() {
    let t = setup();
    let mut q = t.quote();
    q.deadline = NOW + MAX_QUOTE_LIFETIME_SECS + 1;
    t.expect_err(&q, Error::QuoteLifetimeTooLong);
    q.deadline = NOW + MAX_QUOTE_LIFETIME_SECS;
    t.bridge_ok(&q);
}

#[test]
fn revert_reused_nonce() {
    let t = setup();
    let q = t.quote();
    let sig = t.sign(&q);
    t.bridge.bridge(&t.user, &q, &sig);
    assert_eq!(t.try_bridge(&q, &sig), Err(BridgeErr::Contract(Error::NonceUsed)));
}

#[test]
fn revert_reused_nonce_different_quote() {
    let t = setup();
    let q = t.quote();
    t.bridge_ok(&q);
    let mut q2 = t.quote();
    q2.amount = 500_0000000;
    let sig2 = t.sign(&q2);
    assert_eq!(t.try_bridge(&q2, &sig2), Err(BridgeErr::Contract(Error::NonceUsed)));
}

#[test]
fn nonce_entry_ttl_outlives_any_valid_quote() {
    let t = setup();
    let q = t.quote();
    t.bridge_ok(&q);
    let ttl = t.env.as_contract(&t.id, || {
        t.env.storage().persistent().get_ttl(&DataKey::Nonce(q.nonce.clone()))
    });
    assert!(ttl >= NONCE_TTL_LEDGERS, "nonce ttl {ttl}");
    // Even at 1 s per ledger the nonce outlives the longest accepted quote.
    assert!(u64::from(NONCE_TTL_LEDGERS) > MAX_QUOTE_LIFETIME_SECS);
}

#[test]
fn revert_fee_over_cap() {
    let t = setup();
    let mut q = t.quote();
    q.settu_fee = q.amount / 100 + 1;
    t.expect_err(&q, Error::FeeAboveCap);
}

#[test]
fn revert_fee_over_lowered_cap() {
    let t = setup();
    t.bridge.set_max_fee_bps(&4); // 0.04% < the quote's 0.05%
    t.expect_err(&t.quote(), Error::FeeAboveCap);
}

#[test]
fn revert_fees_consume_whole_amount() {
    let t = setup();
    t.bridge.set_max_fee_bps(&10_000);
    let mut q = t.quote();
    q.settu_fee = q.amount - q.network_fee;
    t.expect_err(&q, Error::NothingToBurn);
}

#[test]
fn revert_wrong_user() {
    let t = setup();
    let mut q = t.quote();
    q.user = BytesN::from_array(&t.env, &OTHER_PK); // signed for someone else
    t.expect_err(&q, Error::WrongUser);
}

#[test]
fn revert_quote_for_user_submitted_by_other_account() {
    let t = setup();
    let other = create_account(&t.env, OTHER_PK, USER_XLM);
    create_trustline(&t.env, OTHER_PK, &t.usdc_asset);
    t.usdc_admin.mint(&other, &USER_USDC);
    let q = t.quote(); // for USER_PK
    let sig = t.sign(&q);
    assert_eq!(
        t.bridge.try_bridge(&other, &q, &sig),
        Err(Ok(Error::WrongUser))
    );
}

#[test]
fn revert_contract_address_as_user() {
    let t = setup();
    let q = t.quote();
    let sig = t.sign(&q);
    let c = Address::generate(&t.env);
    assert_eq!(t.bridge.try_bridge(&c, &q, &sig), Err(Ok(Error::UserNotAccount)));
}

#[test]
fn revert_wrong_amount_tampered() {
    let t = setup();
    let mut q = t.quote();
    let sig = t.sign(&q);
    q.amount = 2_000_0000000; // fee still within cap, but not what Settu signed
    t.expect_host_err(&q, &sig);
}

#[test]
fn revert_wrong_amount_exceeds_balance() {
    let t = setup();
    let mut q = t.quote();
    q.amount = USER_USDC + 100; // > dust, so Circle's normalisation can't absorb it
    q.settu_fee = 0;
    let sig = t.sign(&q);
    t.expect_host_err(&q, &sig);
}

#[test]
fn revert_wrong_source_domain() {
    let t = setup();
    let mut q = t.quote();
    q.source_domain = 6;
    t.expect_err(&q, Error::WrongSourceDomain);
}

#[test]
fn revert_out_of_range_amounts() {
    let t = setup();
    let over = i128::from(u64::MAX) + 1;
    for f in 0..5 {
        for v in [-1i128, over] {
            let mut q = t.quote();
            match f {
                0 => q.amount = v,
                1 => q.settu_fee = v,
                2 => q.network_fee = v,
                3 => q.native_fee = v,
                _ => q.max_fee = v,
            }
            let sig = BytesN::from_array(&t.env, &[0; 64]);
            assert_eq!(
                t.try_bridge(&q, &sig),
                Err(BridgeErr::Contract(Error::InvalidAmount)),
                "field {f} value {v}"
            );
        }
    }
    let mut q = t.quote();
    q.amount = 0;
    q.settu_fee = 0;
    q.network_fee = 0;
    t.expect_err(&q, Error::InvalidAmount);
}

#[test]
fn revert_tampered_signature() {
    let t = setup();
    let q = t.quote();
    let mut raw = t.sign(&q).to_array();
    raw[10] ^= 0x01;
    t.expect_host_err(&q, &BytesN::from_array(&t.env, &raw));
}

#[test]
fn revert_tampered_quote_fields() {
    let t = setup();
    let base = t.quote();
    let sig = t.sign(&base);
    let tweaks: [fn(&mut QuoteArgs, &Env); 8] = [
        |q, _| q.dest_domain = 3,
        |q, _| q.settu_fee -= 1,
        |q, _| q.network_fee -= 1,
        |q, e| q.mint_recipient = BytesN::from_array(e, &[0xcd; 32]),
        |q, _| q.max_fee += 1,
        |q, _| q.min_finality = 1000,
        |q, _| q.deadline -= 1,
        |q, e| q.hook_data = Bytes::from_array(e, &[1]),
    ];
    for tweak in tweaks {
        let mut q = base.clone();
        tweak(&mut q, &t.env);
        t.expect_host_err(&q, &sig);
    }
}

#[test]
fn revert_signature_for_other_contract() {
    let t = setup();
    let q = t.quote();
    let msg: StdVec<u8> =
        quote_message(&t.env, &BytesN::from_array(&t.env, &[0x11; 32]), &q).iter().collect();
    let sig = BytesN::from_array(&t.env, &t.sk.sign(&msg).to_bytes());
    t.expect_host_err(&q, &sig);
}

#[test]
fn revert_wrong_signer() {
    let t = setup();
    let q = t.quote();
    let rogue = SigningKey::from_bytes(&[0x99; 32]);
    let msg: StdVec<u8> = quote_message(&t.env, &t.contract_id_bytes(), &q).iter().collect();
    let sig = BytesN::from_array(&t.env, &rogue.sign(&msg).to_bytes());
    t.expect_host_err(&q, &sig);
}

#[test]
fn signer_rotation_invalidates_old_key() {
    let t = setup();
    let q = t.quote();
    let old_sig = t.sign(&q);
    let new_sk = SigningKey::from_bytes(&[0x77; 32]);
    t.bridge.set_signer(&BytesN::from_array(&t.env, &new_sk.verifying_key().to_bytes()));
    t.expect_host_err(&q, &old_sig);
    let msg: StdVec<u8> = quote_message(&t.env, &t.contract_id_bytes(), &q).iter().collect();
    let sig = BytesN::from_array(&t.env, &new_sk.sign(&msg).to_bytes());
    t.bridge.bridge(&t.user, &q, &sig);
}

#[test]
fn revert_paused_then_unpause() {
    let t = setup();
    t.bridge.pause();
    assert!(t.bridge.paused());
    t.expect_err(&t.quote(), Error::Paused);
    t.bridge.unpause();
    assert!(!t.bridge.paused());
    t.bridge_ok(&t.quote());
}

// ------------------------------------------------------------------ owner

fn stranger_auth<'a>(
    t: &'a T,
    who: &'a Address,
    fn_name: &'a str,
    args: soroban_sdk::Vec<soroban_sdk::Val>,
) -> [MockAuth<'a>; 1] {
    let invoke = std::boxed::Box::leak(std::boxed::Box::new(MockAuthInvoke {
        contract: &t.id,
        fn_name,
        args,
        sub_invokes: &[],
    }));
    [MockAuth { address: who, invoke }]
}

#[test]
fn setters_reject_non_owner() {
    let t = setup();
    let s = Address::generate(&t.env);
    let e = &t.env;
    let new_signer = BytesN::from_array(e, &[9; 32]);
    let b = &t.bridge;

    assert!(b.mock_auths(&stranger_auth(&t, &s, "set_signer", (new_signer.clone(),).into_val(e)))
        .try_set_signer(&new_signer).is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "set_fee_wallet", (s.clone(),).into_val(e)))
        .try_set_fee_wallet(&s).is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "set_max_fee_bps", (1u32,).into_val(e)))
        .try_set_max_fee_bps(&1).is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "set_max_network_fee", (1i128,).into_val(e)))
        .try_set_max_network_fee(&1).is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "set_max_native_fee", (1i128,).into_val(e)))
        .try_set_max_native_fee(&1).is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "pause", ().into_val(e))).try_pause().is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "unpause", ().into_val(e))).try_unpause().is_err());
    assert!(b.mock_auths(&stranger_auth(&t, &s, "transfer_ownership", (s.clone(),).into_val(e)))
        .try_transfer_ownership(&s).is_err());

    // Nothing changed.
    assert_eq!(b.signer().to_array(), t.sk.verifying_key().to_bytes());
    assert_eq!(b.fee_wallet(), t.fee_wallet);
    assert_eq!(b.max_fee_bps(), 100);
    assert_eq!(b.max_network_fee(), MAX_NETWORK_FEE);
    assert_eq!(b.max_native_fee(), MAX_NATIVE_FEE);
    assert!(!b.paused());
    assert_eq!(b.owner(), t.owner);
    assert_eq!(b.pending_owner(), None);
}

#[test]
fn setters_owner_can_set_and_owner_auth_is_required() {
    let t = setup();
    let b = &t.bridge;
    let e = &t.env;
    let w = Address::generate(e);
    let new_signer = BytesN::from_array(e, &[9; 32]);

    b.set_signer(&new_signer);
    assert_eq!(e.auths()[0].0, t.owner);
    assert_eq!(b.signer(), new_signer);
    b.set_fee_wallet(&w);
    assert_eq!(e.auths()[0].0, t.owner);
    assert_eq!(b.fee_wallet(), w);
    b.set_max_fee_bps(&250);
    assert_eq!(e.auths()[0].0, t.owner);
    assert_eq!(b.max_fee_bps(), 250);
    b.set_max_network_fee(&123);
    assert_eq!(e.auths()[0].0, t.owner);
    assert_eq!(b.max_network_fee(), 123);
    b.set_max_native_fee(&456);
    assert_eq!(e.auths()[0].0, t.owner);
    assert_eq!(b.max_native_fee(), 456);
    b.pause();
    assert_eq!(e.auths()[0].0, t.owner);
    b.unpause();
    assert_eq!(e.auths()[0].0, t.owner);
}

#[test]
fn setters_reject_bad_values() {
    let t = setup();
    assert_eq!(t.bridge.try_set_max_fee_bps(&10_001), Err(Ok(Error::InvalidBps)));
    assert_eq!(t.bridge.try_set_max_network_fee(&-1), Err(Ok(Error::InvalidLimit)));
    assert_eq!(t.bridge.try_set_max_native_fee(&-1), Err(Ok(Error::InvalidLimit)));
    t.bridge.set_max_fee_bps(&10_000);
}

#[test]
fn ownership_transfer_is_two_step() {
    let t = setup();
    let b = &t.bridge;
    let new_owner = Address::generate(&t.env);
    let s = Address::generate(&t.env);

    assert_eq!(b.try_accept_ownership(), Err(Ok(Error::NoPendingOwner)));
    b.transfer_ownership(&new_owner);
    assert_eq!(b.owner(), t.owner);
    assert_eq!(b.pending_owner(), Some(new_owner.clone()));

    // A stranger cannot accept on the pending owner's behalf.
    assert!(b
        .mock_auths(&stranger_auth(&t, &s, "accept_ownership", ().into_val(&t.env)))
        .try_accept_ownership()
        .is_err());
    assert_eq!(b.owner(), t.owner);

    b.accept_ownership();
    assert_eq!(t.env.auths()[0].0, new_owner);
    assert_eq!(b.owner(), new_owner);
    assert_eq!(b.pending_owner(), None);

    // Old owner is now a stranger.
    let old = t.owner.clone();
    assert!(b
        .mock_auths(&stranger_auth(&t, &old, "pause", ().into_val(&t.env)))
        .try_pause()
        .is_err());
}

// ------------------------------------------------------------------ golden vector

struct Golden {
    contract_id: std::string::String,
    contract_id_hex: [u8; 32],
    user_strkey: std::string::String,
    user_hex: [u8; 32],
    quote_json: serde_json::Value,
    encoded: StdVec<u8>,
    signature: [u8; 64],
    signer: [u8; 32],
    seed: [u8; 32],
}

fn unhex(s: &str) -> StdVec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap()
}

fn golden() -> Golden {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("../../../test-vectors/quotes.json")).unwrap();
    let case = v["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "stellar")
        .unwrap()
        .clone();
    let s = |k: &str| case[k].as_str().unwrap().to_owned();
    Golden {
        contract_id: s("contractId"),
        contract_id_hex: unhex(&s("contractIdHex")).try_into().unwrap(),
        user_strkey: case["quote"]["user"].as_str().unwrap().to_owned(),
        user_hex: unhex(&s("userHex")).try_into().unwrap(),
        encoded: unhex(&s("encoded")),
        signature: unhex(&s("signature")).try_into().unwrap(),
        signer: unhex(&s("signer")).try_into().unwrap(),
        seed: unhex(v["testOnlyKeys"]["ed25519Seed"].as_str().unwrap()).try_into().unwrap(),
        quote_json: case["quote"].clone(),
    }
}

fn golden_quote(env: &Env, g: &Golden) -> QuoteArgs {
    let q = &g.quote_json;
    let n = |k: &str| q[k].as_u64().unwrap();
    let big = |k: &str| q[k].as_str().unwrap().parse::<i128>().unwrap();
    QuoteArgs {
        source_domain: n("sourceDomain") as u32,
        dest_domain: n("destDomain") as u32,
        user: BytesN::from_array(env, &g.user_hex),
        amount: big("amount"),
        settu_fee: big("settuFee"),
        network_fee: big("networkFee"),
        native_fee: big("nativeFee"),
        mint_recipient: BytesN::from_array(
            env,
            &unhex(q["mintRecipient"].as_str().unwrap()).try_into().unwrap(),
        ),
        max_fee: big("maxFee"),
        min_finality: n("minFinality") as u32,
        deadline: q["deadline"].as_str().unwrap().parse().unwrap(),
        nonce: BytesN::from_array(env, &unhex(q["nonce"].as_str().unwrap()).try_into().unwrap()),
        hook_data: Bytes::from_slice(env, &unhex(q["hookData"].as_str().unwrap())),
    }
}

#[test]
fn golden_vector_encoding_and_signature() {
    let g = golden();
    let env = Env::default();
    assert_eq!(g.quote_json["version"], 1);
    let q = golden_quote(&env, &g);
    assert!(!q.hook_data.is_empty(), "vector must exercise hook data");
    let msg = quote_message(&env, &BytesN::from_array(&env, &g.contract_id_hex), &q);
    let got: StdVec<u8> = msg.iter().collect();
    assert_eq!(hex::encode(&got), hex::encode(&g.encoded));
    assert_eq!(got.len() as u32, QUOTE_FIXED_LENGTH + q.hook_data.len());

    // Signer is RFC 8032 TEST 1; the vector's signature verifies over our bytes.
    assert_eq!(SigningKey::from_bytes(&g.seed).verifying_key().to_bytes(), g.signer);
    let vk = VerifyingKey::from_bytes(&g.signer).unwrap();
    vk.verify(&got, &ed25519_dalek::Signature::from_bytes(&g.signature)).unwrap();
    env.crypto().ed25519_verify(
        &BytesN::from_array(&env, &g.signer),
        &msg,
        &BytesN::from_array(&env, &g.signature),
    );
}

/// The contract registered at the vector's exact contract id accepts the
/// vector's server signature end-to-end (hook path, real fee/burn split).
#[test]
fn golden_vector_bridges_end_to_end() {
    let g = golden();
    let t = setup_at(None, SigningKey::from_bytes(&g.seed), g.user_hex);
    let q = golden_quote(&t.env, &g);
    t.env.ledger().with_mut(|l| l.timestamp = q.deadline - 60);
    // Register a second bridge at the vector's exact contract id.
    let at = Address::from_str(&t.env, &g.contract_id);
    let id = t.env.register_at(
        &at,
        SettuBridge,
        (
            t.owner.clone(),
            t.usdc_sac.clone(),
            t.messenger.address.clone(),
            LOCAL,
            BytesN::from_array(&t.env, &g.signer),
            t.fee_wallet.clone(),
            t.xlm.address.clone(),
            MAX_NETWORK_FEE,
            MAX_NATIVE_FEE,
        ),
    );
    assert_eq!(id, at);
    let user_from_vector = Address::from_str(&t.env, &g.user_strkey);
    assert_eq!(user_from_vector, t.user);

    let b = SettuBridgeClient::new(&t.env, &id);
    b.bridge(&t.user, &q, &BytesN::from_array(&t.env, &g.signature));

    let usdc_fee = q.settu_fee + q.network_fee;
    assert_eq!(t.usdc.balance(&t.fee_wallet), usdc_fee);
    assert_eq!(t.usdc.balance(&t.user), USER_USDC - q.amount);
    assert_eq!(t.usdc.balance(&id), 0);
    let c = t.messenger.calls().get(0).unwrap();
    assert!(c.with_hook);
    assert_eq!(c.amount, q.amount - usdc_fee);
    assert_eq!(c.hook_data, q.hook_data);
    assert!(b.is_nonce_used(&q.nonce));
}

#[test]
fn golden_vector_rejected_by_other_contract_id() {
    let g = golden();
    let t = setup_at(None, SigningKey::from_bytes(&g.seed), g.user_hex);
    let q = golden_quote(&t.env, &g);
    t.env.ledger().with_mut(|l| l.timestamp = q.deadline - 60);
    assert_eq!(t.bridge.signer().to_array(), g.signer);
    t.expect_host_err(&q, &BytesN::from_array(&t.env, &g.signature));
}
