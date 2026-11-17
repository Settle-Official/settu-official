//! settu_bridge integration tests on LiteSVM (in-process SVM, no validator).
//!
//! Circle's TokenMessengerMinterV2 is replaced by `mock_cctp` (this workspace),
//! loaded at Circle's real program id. The mock mirrors Circle's account list,
//! discriminators and params from the vendored IDL and records every CPI
//! argument into the `message_sent_event_data` account, which these tests
//! read back. The Ed25519SigVerify precompile is the real one (litesvm
//! `precompiles` feature), so signature checks are end-to-end.
//!
//! Build the .so files first: `anchor build` (or `anchor test`, which builds
//! then runs `cargo test`).

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{
            instruction::{error::InstructionError, Instruction},
            program_pack::Pack,
            system_program,
        },
        AccountDeserialize, AnchorDeserialize, Discriminator, InstructionData, ToAccountMetas,
    },
    anchor_spl::{associated_token::get_associated_token_address, token::spl_token},
    ed25519_dalek::{Signer as _, SigningKey},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    settu_bridge::{cctp, BridgeError, Config, QuoteArgs},
    solana_keypair::Keypair,
    solana_message::{
        v0, AddressLookupTableAccount, Message, VersionedMessage,
    },
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    solana_transaction_error::TransactionError,
};

const TMM: Pubkey = cctp::TOKEN_MESSENGER_MINTER_V2_ID;
const MT: Pubkey = cctp::MESSAGE_TRANSMITTER_V2_ID;
const NOW: i64 = 1_800_000_000;
/// RFC 8032 TEST 1 seed (the golden-vector key). Test only.
const SIGNER_SEED: [u8; 32] = [
    0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec, 0x2c,
    0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03, 0x1c, 0xae,
    0x7f, 0x60,
];
const MAX_NETWORK_FEE: u64 = 2_000_000; // 2 USDC
const MAX_NATIVE_FEE: u64 = 10_000_000; // 0.01 SOL
const USER_USDC: u64 = 1_000_000_000; // 1000 USDC
/// Stellar forwarder hook data (88 bytes), as in the golden vectors.
const STELLAR_HOOK: &str = "000000000000000000000000000000000000000000000000000000000000003847424b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b564b4b334a";

fn so(name: &str) -> Vec<u8> {
    let path = format!("{}/../deploy/{name}.so", env!("CARGO_TARGET_TMPDIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e} (run `anchor build` first)"))
}

fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

fn code(e: BridgeError) -> u32 {
    6000 + e as u32
}

struct Env {
    svm: LiteSVM,
    authority: Keypair,
    signer: SigningKey,
    fee_wallet: Pubkey,
    user: Keypair,
    mint: Pubkey,
    user_ata: Pubkey,
    fee_ata: Pubkey,
    config: Pubkey,
    nonce_counter: u8,
}

fn put_token_account(svm: &mut LiteSVM, addr: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
    let mut data = vec![0u8; spl_token::state::Account::LEN];
    spl_token::state::Account {
        mint,
        owner,
        amount,
        state: spl_token::state::AccountState::Initialized,
        ..Default::default()
    }
    .pack_into_slice(&mut data);
    svm.set_account(
        addr,
        solana_account::Account {
            lamports: svm.minimum_balance_for_rent_exemption(data.len()),
            data,
            owner: spl_token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();
}

fn token_amount(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    spl_token::state::Account::unpack(&svm.get_account(addr).unwrap().data).unwrap().amount
}

fn mint_supply(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    spl_token::state::Mint::unpack(&svm.get_account(addr).unwrap().data).unwrap().supply
}

fn lamports(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    svm.get_account(addr).map(|a| a.lamports).unwrap_or(0)
}

fn send(
    svm: &mut LiteSVM,
    ixs: &[Instruction],
    payer: &Keypair,
    extra: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let msg = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    let r = svm.send_transaction(tx);
    svm.expire_blockhash();
    r
}

fn assert_custom(r: Result<TransactionMetadata, FailedTransactionMetadata>, ix: u8, want: u32) {
    match r {
        Ok(_) => panic!("expected custom error {want} at ix {ix}, got success"),
        Err(e) => assert_eq!(
            e.err,
            TransactionError::InstructionError(ix, InstructionError::Custom(want)),
            "logs:\n{}",
            e.meta.logs.join("\n")
        ),
    }
}

fn assert_bridge_err(r: Result<TransactionMetadata, FailedTransactionMetadata>, e: BridgeError) {
    assert_custom(r, 1, code(e));
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program(settu_bridge::ID, &so("settu_bridge")).unwrap();
        svm.add_program(TMM, &so("mock_cctp")).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = NOW;
        svm.set_sysvar(&clock);

        let authority = Keypair::new();
        set_upgrade_authority(&mut svm, &settu_bridge::ID, Some(authority.pubkey()));
        let user = Keypair::new();
        let fee_wallet = Keypair::new().pubkey();
        for k in [authority.pubkey(), user.pubkey(), fee_wallet] {
            svm.airdrop(&k, 10_000_000_000).unwrap();
        }

        // USDC-like mint, 6 decimals.
        let mint = Keypair::new().pubkey();
        let mut data = vec![0u8; spl_token::state::Mint::LEN];
        spl_token::state::Mint {
            mint_authority: Some(Pubkey::new_unique()).into(),
            supply: USER_USDC,
            decimals: 6,
            is_initialized: true,
            freeze_authority: None.into(),
        }
        .pack_into_slice(&mut data);
        svm.set_account(
            mint,
            solana_account::Account {
                lamports: svm.minimum_balance_for_rent_exemption(data.len()),
                data,
                owner: spl_token::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
        let user_ata = get_associated_token_address(&user.pubkey(), &mint);
        let fee_ata = get_associated_token_address(&fee_wallet, &mint);
        put_token_account(&mut svm, user_ata, mint, user.pubkey(), USER_USDC);
        put_token_account(&mut svm, fee_ata, mint, fee_wallet, 0);

        let signer = SigningKey::from_bytes(&SIGNER_SEED);
        let config = pda(&[settu_bridge::CONFIG_SEED], &settu_bridge::ID);
        let mut env = Env {
            svm,
            authority,
            signer,
            fee_wallet,
            user,
            mint,
            user_ata,
            fee_ata,
            config,
            nonce_counter: 0,
        };
        let ix = env.initialize_ix(&env.authority.pubkey(), 100);
        let auth = env.authority.insecure_clone();
        send(&mut env.svm, &[ix], &auth, &[]).expect("initialize");
        env
    }

    fn initialize_ix(&self, authority: &Pubkey, max_fee_bps: u16) -> Instruction {
        Instruction {
            program_id: settu_bridge::ID,
            accounts: settu_bridge::accounts::Initialize {
                authority: *authority,
                config: self.config,
                usdc_mint: self.mint,
                program: settu_bridge::ID,
                program_data: program_data_address(&settu_bridge::ID),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: settu_bridge::instruction::Initialize {
                signer: Pubkey::new_from_array(self.signer.verifying_key().to_bytes()),
                fee_wallet: self.fee_wallet,
                max_fee_bps,
                max_network_fee: MAX_NETWORK_FEE,
                max_native_fee: MAX_NATIVE_FEE,
            }
            .data(),
        }
    }

    fn config(&self) -> Config {
        let a = self.svm.get_account(&self.config).unwrap();
        Config::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    fn quote(&mut self) -> QuoteArgs {
        self.nonce_counter += 1;
        let mut nonce = [0xee; 32];
        nonce[0] = self.nonce_counter;
        QuoteArgs {
            source_domain: 5,
            dest_domain: 6,
            user: self.user.pubkey(),
            amount: 5_000_000,
            settu_fee: 25_000,
            network_fee: 0,
            native_fee: 0,
            mint_recipient: {
                let mut r = [0u8; 32];
                r[12..].copy_from_slice(&[0x70; 20]);
                r
            },
            max_fee: 650,
            min_finality: 1000,
            deadline: (NOW + 120) as u64,
            nonce,
            hook_data: vec![],
        }
    }

    fn sign(&self, q: &QuoteArgs) -> Instruction {
        let msg = settu_bridge::quote_message(&settu_bridge::ID, q);
        let sig = self.signer.sign(&msg).to_bytes();
        solana_ed25519_program::new_ed25519_instruction_with_signature(
            &msg,
            &sig,
            &self.signer.verifying_key().to_bytes(),
        )
    }

    fn bridge_accounts(&self, q: &QuoteArgs, event: &Pubkey) -> settu_bridge::accounts::Bridge {
        settu_bridge::accounts::Bridge {
            user: self.user.pubkey(),
            config: self.config,
            nonce_record: pda(&[settu_bridge::NONCE_SEED, &q.nonce], &settu_bridge::ID),
            burn_token_account: self.user_ata,
            fee_wallet: self.fee_wallet,
            fee_token_account: self.fee_ata,
            usdc_mint: self.mint,
            instructions: settu_bridge::INSTRUCTIONS_SYSVAR_ID,
            sender_authority_pda: pda(&[b"sender_authority"], &TMM),
            denylist_account: pda(&[b"denylist_account", self.user.pubkey().as_ref()], &TMM),
            message_transmitter: pda(&[b"message_transmitter"], &MT),
            token_messenger: pda(&[b"token_messenger"], &TMM),
            remote_token_messenger: pda(
                &[b"remote_token_messenger", q.dest_domain.to_string().as_bytes()],
                &TMM,
            ),
            token_minter: pda(&[b"token_minter"], &TMM),
            local_token: pda(&[b"local_token", self.mint.as_ref()], &TMM),
            message_sent_event_data: *event,
            message_transmitter_program: MT,
            token_messenger_minter_program: TMM,
            token_program: spl_token::ID,
            system_program: system_program::ID,
            event_authority: pda(&[b"__event_authority"], &TMM),
        }
    }

    fn bridge_ix_with(&self, q: &QuoteArgs, accounts: settu_bridge::accounts::Bridge) -> Instruction {
        Instruction {
            program_id: settu_bridge::ID,
            accounts: accounts.to_account_metas(None),
            data: settu_bridge::instruction::Bridge { quote: q.clone() }.data(),
        }
    }

    fn bridge_ix(&self, q: &QuoteArgs, event: &Pubkey) -> Instruction {
        self.bridge_ix_with(q, self.bridge_accounts(q, event))
    }

    /// Signs `signed`, submits `sent` as the bridge args.
    fn run_with(
        &mut self,
        signed: &QuoteArgs,
        sent: &QuoteArgs,
    ) -> (Keypair, Result<TransactionMetadata, FailedTransactionMetadata>) {
        let event = Keypair::new();
        let ixs = [self.sign(signed), self.bridge_ix(sent, &event.pubkey())];
        let user = self.user.insecure_clone();
        let r = send(&mut self.svm, &ixs, &user, &[&event]);
        (event, r)
    }

    fn run(&mut self, q: &QuoteArgs) -> (Keypair, Result<TransactionMetadata, FailedTransactionMetadata>) {
        self.run_with(q, q)
    }

    fn owner_ix(&self, owner: &Pubkey, data: Vec<u8>) -> Instruction {
        Instruction {
            program_id: settu_bridge::ID,
            accounts: settu_bridge::accounts::OwnerOnly { owner: *owner, config: self.config }
                .to_account_metas(None),
            data,
        }
    }
}

fn program_data_address(program: &Pubkey) -> Pubkey {
    pda(&[program.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID)
}

/// LiteSVM deploys with no upgrade authority; rewrite the ProgramData header.
fn set_upgrade_authority(svm: &mut LiteSVM, program: &Pubkey, authority: Option<Pubkey>) {
    use anchor_lang::solana_program::bpf_loader_upgradeable::UpgradeableLoaderState;
    let addr = program_data_address(program);
    let mut acc = svm.get_account(&addr).unwrap();
    let meta_len = UpgradeableLoaderState::size_of_programdata_metadata();
    let header = bincode::serialize(&UpgradeableLoaderState::ProgramData {
        slot: 0,
        upgrade_authority_address: authority,
    })
    .unwrap();
    acc.data[..meta_len].fill(0);
    acc.data[..header.len()].copy_from_slice(&header);
    svm.set_account(addr, acc).unwrap();
}

fn burn_record(svm: &LiteSVM, event: &Pubkey) -> mock_cctp::BurnRecord {
    let a = svm.get_account(event).expect("CCTP event account created");
    assert_eq!(a.owner, TMM);
    mock_cctp::BurnRecord::try_deserialize(&mut a.data.as_slice()).unwrap()
}

fn bridged_event(meta: &TransactionMetadata) -> settu_bridge::Bridged {
    use base64::Engine;
    for l in &meta.logs {
        if let Some(b64) = l.strip_prefix("Program data: ") {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
            if bytes.starts_with(settu_bridge::Bridged::DISCRIMINATOR) {
                let mut rest = &bytes[settu_bridge::Bridged::DISCRIMINATOR.len()..];
                return settu_bridge::Bridged::deserialize(&mut rest).unwrap();
            }
        }
    }
    panic!("no Bridged event in logs:\n{}", meta.logs.join("\n"));
}

/// The program must end every bridge holding nothing: config keeps exactly
/// its rent, and no token account is owned by the program or its PDAs.
fn assert_program_holds_nothing(env: &Env) {
    let cfg = env.svm.get_account(&env.config).unwrap();
    assert_eq!(cfg.lamports, env.svm.minimum_balance_for_rent_exemption(cfg.data.len()));
    for addr in [env.user_ata, env.fee_ata] {
        let a = spl_token::state::Account::unpack(&env.svm.get_account(&addr).unwrap().data).unwrap();
        assert_ne!(a.owner, settu_bridge::ID);
        assert_ne!(a.owner, env.config);
    }
}

// ------------------------------------------------------------------ happy paths

#[test]
fn usdc_mode_moves_exact_fees_and_burns_the_rest() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.network_fee = 630_000;
    let supply0 = mint_supply(&env.svm, &env.mint);
    let fee_lamports0 = lamports(&env.svm, &env.fee_wallet);

    let (event, r) = env.run(&q);
    let meta = r.unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));

    let fee = 25_000 + 630_000;
    let burn = 5_000_000 - fee;
    assert_eq!(token_amount(&env.svm, &env.user_ata), USER_USDC - 5_000_000);
    assert_eq!(token_amount(&env.svm, &env.fee_ata), fee);
    assert_eq!(mint_supply(&env.svm, &env.mint), supply0 - burn);
    assert_eq!(lamports(&env.svm, &env.fee_wallet), fee_lamports0, "no native fee");

    let rec = burn_record(&env.svm, &event.pubkey());
    assert!(!rec.with_hook);
    assert_eq!(rec.depositor, env.user.pubkey());
    assert_eq!(rec.burn_token, env.mint);
    assert_eq!(rec.amount, burn);
    assert_eq!(rec.destination_domain, 6);
    assert_eq!(rec.mint_recipient.to_bytes(), q.mint_recipient);
    assert_eq!(rec.destination_caller, Pubkey::default());
    assert_eq!(rec.max_fee, 650);
    assert_eq!(rec.min_finality_threshold, 1000);
    assert!(rec.hook_data.is_empty());

    let ev = bridged_event(&meta);
    assert_eq!(ev.nonce, q.nonce);
    assert_eq!(ev.user, env.user.pubkey());
    assert_eq!(ev.amount, 5_000_000);
    assert_eq!(ev.settu_fee, 25_000);
    assert_eq!(ev.network_fee, 630_000);
    assert_eq!(ev.native_fee, 0);
    assert_eq!(ev.dest_domain, 6);
    assert_eq!(ev.mint_recipient, q.mint_recipient);
    assert_eq!(ev.min_finality, 1000);

    let nonce_pda = pda(&[settu_bridge::NONCE_SEED, &q.nonce], &settu_bridge::ID);
    assert_eq!(env.svm.get_account(&nonce_pda).unwrap().owner, settu_bridge::ID);
    assert_program_holds_nothing(&env);
}

#[test]
fn native_mode_sends_exact_lamports_to_fee_wallet() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.native_fee = 2_039_280;
    let fee_lamports0 = lamports(&env.svm, &env.fee_wallet);
    let user_lamports0 = lamports(&env.svm, &env.user.pubkey());

    let (event, r) = env.run(&q);
    let meta = r.unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));

    assert_eq!(lamports(&env.svm, &env.fee_wallet), fee_lamports0 + 2_039_280);
    let nonce_pda = pda(&[settu_bridge::NONCE_SEED, &q.nonce], &settu_bridge::ID);
    let nonce_rent = lamports(&env.svm, &nonce_pda);
    let event_rent = lamports(&env.svm, &event.pubkey());
    assert_eq!(
        lamports(&env.svm, &env.user.pubkey()),
        user_lamports0 - 2_039_280 - nonce_rent - event_rent - meta.fee,
        "user pays exactly native fee + nonce rent + CCTP event rent + tx fee"
    );
    assert_eq!(token_amount(&env.svm, &env.fee_ata), 25_000);
    assert_eq!(burn_record(&env.svm, &event.pubkey()).amount, 5_000_000 - 25_000);
    assert_eq!(bridged_event(&meta).native_fee, 2_039_280);
    assert_program_holds_nothing(&env);
}

#[test]
fn hook_data_uses_deposit_for_burn_with_hook() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.dest_domain = 27;
    q.min_finality = 2000;
    q.max_fee = 0;
    q.hook_data = hex::decode(STELLAR_HOOK).unwrap();
    let (event, r) = env.run(&q);
    r.unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
    let rec = burn_record(&env.svm, &event.pubkey());
    assert!(rec.with_hook);
    assert_eq!(rec.hook_data, q.hook_data);
    assert_eq!(rec.destination_domain, 27);
    assert_eq!(rec.min_finality_threshold, 2000);
}

#[test]
fn fee_exactly_at_cap_and_deadline_now_pass() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.settu_fee = 50_000; // exactly 1% of 5 USDC
    q.deadline = NOW as u64;
    q.network_fee = MAX_NETWORK_FEE;
    q.native_fee = MAX_NATIVE_FEE;
    let (_, r) = env.run(&q);
    r.unwrap_or_else(|e| panic!("{:?}\n{}", e.err, e.meta.logs.join("\n")));
}

// ------------------------------------------------------------------ quote checks

#[test]
fn network_fee_over_max_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.network_fee = MAX_NETWORK_FEE + 1;
    assert_bridge_err(env.run(&q).1, BridgeError::NetworkFeeAboveMax);
}

#[test]
fn native_fee_over_max_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.native_fee = MAX_NATIVE_FEE + 1;
    assert_bridge_err(env.run(&q).1, BridgeError::NativeFeeAboveMax);
}

#[test]
fn native_amount_not_matching_signed_native_fee_reverts() {
    // On Solana the program moves exactly quote.native_fee; a client that
    // sends a different native_fee than was signed fails the signature check.
    let mut env = Env::new();
    let mut signed = env.quote();
    signed.native_fee = 2_039_280;
    let mut sent = signed.clone();
    sent.native_fee = 1;
    assert_bridge_err(env.run_with(&signed, &sent).1, BridgeError::Ed25519MessageMismatch);
    sent.native_fee = 0;
    assert_bridge_err(env.run_with(&signed, &sent).1, BridgeError::Ed25519MessageMismatch);
}

#[test]
fn user_without_lamports_for_native_fee_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.native_fee = MAX_NATIVE_FEE;
    // Leave the user just enough for fees + rents but not the native fee.
    let user = env.user.pubkey();
    let mut a = env.svm.get_account(&user).unwrap();
    a.lamports = 5_000_000;
    env.svm.set_account(user, a).unwrap();
    assert!(env.run(&q).1.is_err());
    assert_eq!(token_amount(&env.svm, &env.user_ata), USER_USDC);
}

#[test]
fn expired_quote_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.deadline = (NOW - 1) as u64;
    assert_bridge_err(env.run(&q).1, BridgeError::QuoteExpired);
}

#[test]
fn reused_nonce_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    env.run(&q).1.expect("first use");
    let before = token_amount(&env.svm, &env.user_ata);
    let (_, r) = env.run(&q);
    let e = r.expect_err("second use must fail");
    assert!(matches!(e.err, TransactionError::InstructionError(1, _)), "{:?}", e.err);
    assert!(
        e.meta.logs.iter().any(|l| l.contains("already in use")),
        "{}",
        e.meta.logs.join("\n")
    );
    assert_eq!(token_amount(&env.svm, &env.user_ata), before);
}

#[test]
fn fee_over_cap_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.settu_fee = 50_001;
    assert_bridge_err(env.run(&q).1, BridgeError::FeeAboveCap);
    // Overflow-safe at the extremes.
    let mut q = env.quote();
    q.amount = u64::MAX;
    q.settu_fee = u64::MAX;
    assert_bridge_err(env.run(&q).1, BridgeError::FeeAboveCap);
}

#[test]
fn wrong_user_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.user = Pubkey::new_unique();
    assert_bridge_err(env.run(&q).1, BridgeError::WrongUser);
}

#[test]
fn wrong_amount_reverts() {
    let mut env = Env::new();
    let signed = env.quote();
    let mut sent = signed.clone();
    sent.amount += 1;
    assert_bridge_err(env.run_with(&signed, &sent).1, BridgeError::Ed25519MessageMismatch);
    let mut sent = signed.clone();
    sent.settu_fee -= 1;
    assert_bridge_err(env.run_with(&signed, &sent).1, BridgeError::Ed25519MessageMismatch);
    let mut sent = signed.clone();
    sent.mint_recipient[31] ^= 1;
    assert_bridge_err(env.run_with(&signed, &sent).1, BridgeError::Ed25519MessageMismatch);
}

#[test]
fn wrong_domain_reverts() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.source_domain = 6;
    assert_bridge_err(env.run(&q).1, BridgeError::WrongSourceDomain);
}

#[test]
fn nothing_to_burn_reverts() {
    let mut env = Env::new();
    env.svm.expire_blockhash();
    let owner = env.authority.insecure_clone();
    let ix = env.owner_ix(
        &owner.pubkey(),
        settu_bridge::instruction::SetMaxFeeBps { max_fee_bps: 10_000 }.data(),
    );
    send(&mut env.svm, &[ix], &owner, &[]).unwrap();
    let mut q = env.quote();
    q.settu_fee = q.amount;
    assert_bridge_err(env.run(&q).1, BridgeError::NothingToBurn);
    let mut q = env.quote();
    q.amount = 0;
    q.settu_fee = 0;
    assert_bridge_err(env.run(&q).1, BridgeError::InvalidAmount);
}

#[test]
fn paused_reverts_and_unpause_restores() {
    let mut env = Env::new();
    let owner = env.authority.insecure_clone();
    let ix = env.owner_ix(&owner.pubkey(), settu_bridge::instruction::SetPaused { paused: true }.data());
    send(&mut env.svm, &[ix], &owner, &[]).unwrap();
    assert!(env.config().paused);
    let q = env.quote();
    assert_bridge_err(env.run(&q).1, BridgeError::Paused);
    let ix = env.owner_ix(&owner.pubkey(), settu_bridge::instruction::SetPaused { paused: false }.data());
    send(&mut env.svm, &[ix], &owner, &[]).unwrap();
    env.run(&q).1.expect("works after unpause");
}

// ------------------------------------------------------------------ signature checks

#[test]
fn tampered_signature_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    let mut sig_ix = env.sign(&q);
    sig_ix.data[48] ^= 1; // signature starts at offset 48
    let event = Keypair::new();
    let ixs = [sig_ix, env.bridge_ix(&q, &event.pubkey())];
    let user = env.user.insecure_clone();
    let e = send(&mut env.svm, &ixs, &user, &[&event]).expect_err("precompile rejects");
    assert!(matches!(e.err, TransactionError::InstructionError(0, _)), "{:?}", e.err);
    assert_eq!(token_amount(&env.svm, &env.user_ata), USER_USDC);
}

#[test]
fn missing_ed25519_instruction_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    let event = Keypair::new();
    let user = env.user.insecure_clone();
    let ix = env.bridge_ix(&q, &event.pubkey());
    assert_custom(
        send(&mut env.svm, &[ix], &user, &[&event]),
        0,
        code(BridgeError::MissingEd25519Instruction),
    );
}

#[test]
fn ed25519_not_immediately_before_bridge_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    let event = Keypair::new();
    let user = env.user.insecure_clone();
    // A valid signature, but with another instruction in between.
    let filler = anchor_lang::solana_program::system_instruction::transfer(
        &user.pubkey(),
        &user.pubkey(),
        0,
    );
    let ixs = [env.sign(&q), filler, env.bridge_ix(&q, &event.pubkey())];
    assert_custom(
        send(&mut env.svm, &ixs, &user, &[&event]),
        2,
        code(BridgeError::MissingEd25519Instruction),
    );
}

#[test]
fn ed25519_over_different_bytes_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    // Validly signed by the real signer, but over a different message.
    let other = b"not the quote".to_vec();
    let sig = env.signer.sign(&other).to_bytes();
    let sig_ix = solana_ed25519_program::new_ed25519_instruction_with_signature(
        &other,
        &sig,
        &env.signer.verifying_key().to_bytes(),
    );
    let event = Keypair::new();
    let ixs = [sig_ix, env.bridge_ix(&q, &event.pubkey())];
    let user = env.user.insecure_clone();
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::Ed25519MessageMismatch);

    // Quote signed for a different program id.
    let msg = settu_bridge::quote_message(&Pubkey::new_unique(), &q);
    let sig = env.signer.sign(&msg).to_bytes();
    let sig_ix = solana_ed25519_program::new_ed25519_instruction_with_signature(
        &msg,
        &sig,
        &env.signer.verifying_key().to_bytes(),
    );
    let event = Keypair::new();
    let ixs = [sig_ix, env.bridge_ix(&q, &event.pubkey())];
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::Ed25519MessageMismatch);
}

#[test]
fn ed25519_by_another_key_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    let msg = settu_bridge::quote_message(&settu_bridge::ID, &q);
    let rogue = SigningKey::from_bytes(&[42; 32]);
    let sig_ix = solana_ed25519_program::new_ed25519_instruction_with_signature(
        &msg,
        &rogue.sign(&msg).to_bytes(),
        &rogue.verifying_key().to_bytes(),
    );
    let event = Keypair::new();
    let ixs = [sig_ix, env.bridge_ix(&q, &event.pubkey())];
    let user = env.user.insecure_clone();
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::Ed25519SignerMismatch);
}

#[test]
fn ed25519_with_two_signatures_reverts() {
    let mut env = Env::new();
    let q = env.quote();
    let msg = settu_bridge::quote_message(&settu_bridge::ID, &q);
    let sig = env.signer.sign(&msg).to_bytes();
    let pk = env.signer.verifying_key().to_bytes();
    // Two offsets entries, both pointing at the same (valid) pk/sig/msg.
    let data_start = 2 + 2 * 14;
    let (pk_off, sig_off, msg_off) = (data_start, data_start + 32, data_start + 96);
    let mut data = vec![2u8, 0];
    for _ in 0..2 {
        for v in [sig_off, u16::MAX as usize, pk_off, u16::MAX as usize, msg_off, msg.len(), u16::MAX as usize] {
            data.extend_from_slice(&(v as u16).to_le_bytes());
        }
    }
    data.extend_from_slice(&pk);
    data.extend_from_slice(&sig);
    data.extend_from_slice(&msg);
    let sig_ix = Instruction {
        program_id: settu_bridge::ed25519::ED25519_PROGRAM_ID,
        accounts: vec![],
        data,
    };
    let event = Keypair::new();
    let ixs = [sig_ix, env.bridge_ix(&q, &event.pubkey())];
    let user = env.user.insecure_clone();
    assert_bridge_err(
        send(&mut env.svm, &ixs, &user, &[&event]),
        BridgeError::MalformedEd25519Instruction,
    );
}

#[test]
fn ed25519_referencing_another_instruction_reverts() {
    // The signature data lives in the bridge instruction (index 1) instead
    // of the ed25519 instruction itself: the runtime would verify it, but we
    // require self-contained data.
    let mut env = Env::new();
    let q = env.quote();
    let msg = settu_bridge::quote_message(&settu_bridge::ID, &q);
    let sig = env.signer.sign(&msg).to_bytes();
    let mut ix = env.sign(&q);
    ix.data = {
        let mut d = solana_ed25519_program::new_ed25519_instruction_with_signature(
            &msg,
            &sig,
            &env.signer.verifying_key().to_bytes(),
        )
        .data;
        d[14..16].copy_from_slice(&0u16.to_le_bytes()); // message from ix 0 (itself, by index)
        d
    };
    let event = Keypair::new();
    let ixs = [ix, env.bridge_ix(&q, &event.pubkey())];
    let user = env.user.insecure_clone();
    assert_bridge_err(
        send(&mut env.svm, &ixs, &user, &[&event]),
        BridgeError::MalformedEd25519Instruction,
    );
}

// ------------------------------------------------------------------ account checks

#[test]
fn wrong_fee_accounts_and_mint_and_cctp_program_revert() {
    let mut env = Env::new();
    let user = env.user.insecure_clone();

    let q = env.quote();
    let event = Keypair::new();
    let mut a = env.bridge_accounts(&q, &event.pubkey());
    a.fee_wallet = Pubkey::new_unique();
    let ixs = [env.sign(&q), env.bridge_ix_with(&q, a)];
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::WrongFeeWallet);

    // A token account of the fee wallet that is not its ATA.
    let rogue = Pubkey::new_unique();
    put_token_account(&mut env.svm, rogue, env.mint, user.pubkey(), 0);
    let event = Keypair::new();
    let mut a = env.bridge_accounts(&q, &event.pubkey());
    a.fee_token_account = rogue;
    let ixs = [env.sign(&q), env.bridge_ix_with(&q, a)];
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::WrongFeeTokenAccount);

    let event = Keypair::new();
    let mut a = env.bridge_accounts(&q, &event.pubkey());
    a.token_messenger_minter_program = settu_bridge::ID;
    let ixs = [env.sign(&q), env.bridge_ix_with(&q, a)];
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::WrongCctpProgram);

    let event = Keypair::new();
    let mut a = env.bridge_accounts(&q, &event.pubkey());
    a.message_transmitter_program = Pubkey::new_unique();
    let ixs = [env.sign(&q), env.bridge_ix_with(&q, a)];
    assert_bridge_err(send(&mut env.svm, &ixs, &user, &[&event]), BridgeError::WrongCctpProgram);

    // Burning from someone else's token account.
    let other = Pubkey::new_unique();
    put_token_account(&mut env.svm, other, env.mint, Pubkey::new_unique(), USER_USDC);
    let event = Keypair::new();
    let mut a = env.bridge_accounts(&q, &event.pubkey());
    a.burn_token_account = other;
    let ixs = [env.sign(&q), env.bridge_ix_with(&q, a)];
    assert!(send(&mut env.svm, &ixs, &user, &[&event]).is_err());
    assert_eq!(token_amount(&env.svm, &other), USER_USDC);

    // Nothing moved in any of the above.
    assert_eq!(token_amount(&env.svm, &env.user_ata), USER_USDC);
    // And the honest call still works with the same nonce.
    env.run(&q).1.expect("honest bridge");
}

#[test]
fn circle_side_checks_are_enforced_by_the_mock() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.max_fee = q.amount - q.settu_fee; // == burn amount: Circle requires max_fee < amount
    let e = env.run(&q).1.expect_err("max_fee >= burn");
    assert!(matches!(e.err, TransactionError::InstructionError(1, _)));
    let mut q = env.quote();
    q.mint_recipient = [0; 32];
    assert!(env.run(&q).1.is_err());
    assert_eq!(token_amount(&env.svm, &env.user_ata), USER_USDC);
}

// ------------------------------------------------------------------ owner

#[test]
fn each_setter_rejects_non_owner() {
    let mut env = Env::new();
    let rogue = Keypair::new();
    env.svm.airdrop(&rogue.pubkey(), 1_000_000_000).unwrap();
    let datas: Vec<Vec<u8>> = vec![
        settu_bridge::instruction::SetSigner { signer: Pubkey::new_unique() }.data(),
        settu_bridge::instruction::SetFeeWallet { fee_wallet: Pubkey::new_unique() }.data(),
        settu_bridge::instruction::SetMaxFeeBps { max_fee_bps: 5000 }.data(),
        settu_bridge::instruction::SetMaxNetworkFee { max_network_fee: u64::MAX }.data(),
        settu_bridge::instruction::SetMaxNativeFee { max_native_fee: u64::MAX }.data(),
        settu_bridge::instruction::SetPaused { paused: true }.data(),
        settu_bridge::instruction::TransferOwnership { new_owner: rogue.pubkey() }.data(),
    ];
    let before = env.svm.get_account(&env.config).unwrap().data;
    for d in datas {
        let ix = env.owner_ix(&rogue.pubkey(), d);
        assert_custom(send(&mut env.svm, &[ix], &rogue, &[]), 0, code(BridgeError::NotOwner));
    }
    assert_eq!(env.svm.get_account(&env.config).unwrap().data, before);
}

#[test]
fn owner_setters_update_config() {
    let mut env = Env::new();
    let owner = env.authority.insecure_clone();
    let (s, f) = (Pubkey::new_unique(), Pubkey::new_unique());
    for d in [
        settu_bridge::instruction::SetSigner { signer: s }.data(),
        settu_bridge::instruction::SetFeeWallet { fee_wallet: f }.data(),
        settu_bridge::instruction::SetMaxFeeBps { max_fee_bps: 250 }.data(),
        settu_bridge::instruction::SetMaxNetworkFee { max_network_fee: 7 }.data(),
        settu_bridge::instruction::SetMaxNativeFee { max_native_fee: 8 }.data(),
    ] {
        let ix = env.owner_ix(&owner.pubkey(), d);
        send(&mut env.svm, &[ix], &owner, &[]).unwrap();
    }
    let c = env.config();
    assert_eq!((c.signer, c.fee_wallet, c.max_fee_bps, c.max_network_fee, c.max_native_fee), (s, f, 250, 7, 8));

    let ix = env.owner_ix(&owner.pubkey(), settu_bridge::instruction::SetMaxFeeBps { max_fee_bps: 10_001 }.data());
    assert_custom(send(&mut env.svm, &[ix], &owner, &[]), 0, code(BridgeError::InvalidBps));
    let ix = env.owner_ix(&owner.pubkey(), settu_bridge::instruction::SetSigner { signer: Pubkey::default() }.data());
    assert_custom(send(&mut env.svm, &[ix], &owner, &[]), 0, code(BridgeError::ZeroAddress));
}

#[test]
fn rotated_signer_invalidates_old_key() {
    let mut env = Env::new();
    let owner = env.authority.insecure_clone();
    let new_key = SigningKey::from_bytes(&[5; 32]);
    let ix = env.owner_ix(
        &owner.pubkey(),
        settu_bridge::instruction::SetSigner {
            signer: Pubkey::new_from_array(new_key.verifying_key().to_bytes()),
        }
        .data(),
    );
    send(&mut env.svm, &[ix], &owner, &[]).unwrap();
    let q = env.quote();
    assert_bridge_err(env.run(&q).1, BridgeError::Ed25519SignerMismatch);
    env.signer = new_key;
    env.run(&q).1.expect("new key works");
}

#[test]
fn two_step_ownership_transfer() {
    let mut env = Env::new();
    let owner = env.authority.insecure_clone();
    let next = Keypair::new();
    let rogue = Keypair::new();
    for k in [&next, &rogue] {
        env.svm.airdrop(&k.pubkey(), 1_000_000_000).unwrap();
    }
    let accept = |env: &Env, who: &Pubkey| Instruction {
        program_id: settu_bridge::ID,
        accounts: settu_bridge::accounts::AcceptOwnership { pending_owner: *who, config: env.config }
            .to_account_metas(None),
        data: settu_bridge::instruction::AcceptOwnership {}.data(),
    };
    // Nothing pending yet.
    let ix = accept(&env, &next.pubkey());
    assert_custom(send(&mut env.svm, &[ix], &next, &[]), 0, code(BridgeError::NotPendingOwner));

    let ix = env.owner_ix(
        &owner.pubkey(),
        settu_bridge::instruction::TransferOwnership { new_owner: next.pubkey() }.data(),
    );
    send(&mut env.svm, &[ix], &owner, &[]).unwrap();
    assert_eq!(env.config().owner, owner.pubkey(), "still the old owner until accepted");
    assert_eq!(env.config().pending_owner, Some(next.pubkey()));

    let ix = accept(&env, &rogue.pubkey());
    assert_custom(send(&mut env.svm, &[ix], &rogue, &[]), 0, code(BridgeError::NotPendingOwner));
    let ix = accept(&env, &next.pubkey());
    send(&mut env.svm, &[ix], &next, &[]).unwrap();
    assert_eq!(env.config().owner, next.pubkey());
    assert_eq!(env.config().pending_owner, None);

    // Old owner lost control; new owner has it.
    let ix = env.owner_ix(&owner.pubkey(), settu_bridge::instruction::SetPaused { paused: true }.data());
    assert_custom(send(&mut env.svm, &[ix], &owner, &[]), 0, code(BridgeError::NotOwner));
    let ix = env.owner_ix(&next.pubkey(), settu_bridge::instruction::SetPaused { paused: true }.data());
    send(&mut env.svm, &[ix], &next, &[]).unwrap();
}

#[test]
fn initialize_is_upgrade_authority_only_and_once() {
    let mut env = Env::new();
    let c = env.config();
    assert_eq!(c.owner, env.authority.pubkey());
    assert_eq!(c.max_fee_bps, 100);
    assert_eq!(c.usdc_mint, env.mint);
    assert_eq!(c.fee_wallet, env.fee_wallet);
    assert_eq!(c.max_network_fee, MAX_NETWORK_FEE);
    assert_eq!(c.max_native_fee, MAX_NATIVE_FEE);
    assert!(!c.paused);

    // Second initialize fails (config exists).
    let auth = env.authority.insecure_clone();
    let ix = env.initialize_ix(&auth.pubkey(), 100);
    assert!(send(&mut env.svm, &[ix], &auth, &[]).is_err());

    // Fresh program: a non-upgrade-authority can't initialize.
    let mut svm = LiteSVM::new();
    svm.add_program(settu_bridge::ID, &so("settu_bridge")).unwrap();
    let real = Keypair::new();
    set_upgrade_authority(&mut svm, &settu_bridge::ID, Some(real.pubkey()));
    let rogue = Keypair::new();
    svm.airdrop(&rogue.pubkey(), 1_000_000_000).unwrap();
    let mint_account = env.svm.get_account(&env.mint).unwrap();
    svm.set_account(env.mint, mint_account).unwrap();
    let ix = env.initialize_ix(&rogue.pubkey(), 100);
    assert_custom(send(&mut svm, &[ix], &rogue, &[]), 0, code(BridgeError::NotUpgradeAuthority));
    // Immutable program (no upgrade authority): nobody can.
    set_upgrade_authority(&mut svm, &settu_bridge::ID, None);
    let ix = env.initialize_ix(&rogue.pubkey(), 100);
    assert_custom(send(&mut svm, &[ix], &rogue, &[]), 0, code(BridgeError::NotUpgradeAuthority));
    // bps above 100% rejected.
    set_upgrade_authority(&mut svm, &settu_bridge::ID, Some(rogue.pubkey()));
    let ix = env.initialize_ix(&rogue.pubkey(), 10_001);
    assert_custom(send(&mut svm, &[ix], &rogue, &[]), 0, code(BridgeError::InvalidBps));
}

// ------------------------------------------------------------------ tx size

/// The bridge transaction must fit Solana's 1232-byte packet. It only does as
/// a v0 transaction with the static accounts in an address lookup table; this
/// pins the budget for the TypeScript builder (worst case: Stellar hook data).
#[test]
fn bridge_tx_fits_with_address_lookup_table() {
    let mut env = Env::new();
    let mut q = env.quote();
    q.dest_domain = 27;
    q.hook_data = hex::decode(STELLAR_HOOK).unwrap();
    let event = Keypair::new();
    let a = env.bridge_accounts(&q, &event.pubkey());
    let alt_addresses = vec![
        a.config,
        a.fee_wallet,
        a.fee_token_account,
        a.usdc_mint,
        a.instructions,
        a.sender_authority_pda,
        a.message_transmitter,
        a.token_messenger,
        a.remote_token_messenger,
        a.token_minter,
        a.local_token,
        a.message_transmitter_program,
        a.token_messenger_minter_program,
        a.token_program,
        a.system_program,
        a.event_authority,
    ];
    let compute = Instruction {
        program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(),
        accounts: vec![],
        data: vec![2, 0x40, 0x0d, 0x03, 0x00], // SetComputeUnitLimit(200_000)
    };
    let price = Instruction {
        program_id: "ComputeBudget111111111111111111111111111111".parse().unwrap(),
        accounts: vec![],
        data: vec![3, 1, 0, 0, 0, 0, 0, 0, 0], // SetComputeUnitPrice(1)
    };
    let ixs = vec![compute, price, env.sign(&q), env.bridge_ix_with(&q, a)];
    let user = env.user.insecure_clone();

    let legacy = Message::new_with_blockhash(&ixs, Some(&user.pubkey()), &env.svm.latest_blockhash());
    let legacy_tx = VersionedTransaction::try_new(VersionedMessage::Legacy(legacy), &[&user, &event]).unwrap();
    let legacy_len = bincode::serialize(&legacy_tx).unwrap().len();

    let alt = AddressLookupTableAccount { key: Pubkey::new_unique(), addresses: alt_addresses };
    let v0 = v0::Message::try_compile(&user.pubkey(), &ixs, &[alt], env.svm.latest_blockhash()).unwrap();
    let v0_tx = VersionedTransaction::try_new(VersionedMessage::V0(v0), &[&user, &event]).unwrap();
    let v0_len = bincode::serialize(&v0_tx).unwrap().len();
    println!("bridge tx bytes: legacy {legacy_len}, v0+ALT {v0_len} (limit 1232)");
    assert!(v0_len <= 1232, "v0 tx {v0_len} bytes");
}
