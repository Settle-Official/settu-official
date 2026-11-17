# settu_bridge (Solana / Anchor)

One Anchor program. In a single user-signed transaction it verifies a
Settu-signed ed25519 quote, sends the quoted fees to Settu's fee wallet (USDC,
plus an optional SOL fee), and burns the rest of the USDC through Circle CCTP
V2 TokenMessengerMinterV2 `deposit_for_burn` (or `deposit_for_burn_with_hook`
when the quote carries `hook_data`). See spec §5 and §5.3 in
`docs/superpowers/specs/2026-11-16-user-bridge-design.md`.

Program id (testnet): `3CGxb2E9ASpizQtoL8wykokiZ8BH19MXMWmgy17KQmD1`.

## Transaction shape

```
[ComputeBudget ...]                 optional
Ed25519SigVerify(signer, sig, msg)  MUST be immediately before bridge
settu_bridge::bridge(quote)
```

- `msg` = `encodeQuoteBytes(quote, "solana", programId)` from
  `src/lib/bridge/quote.ts` (same bytes as `quote::quote_message`). The
  golden vector is the `solana` case of `contracts/test-vectors/quotes.json`.
- The Ed25519SigVerify instruction must hold exactly one signature, and its
  three `*_instruction_index` fields must all be `u16::MAX` (the data lives in
  that instruction). `@solana/web3.js`'s
  `Ed25519Program.createInstructionWithPublicKey` produces exactly this.
- Signers: the user (fee payer) and a fresh keypair for CCTP's
  `message_sent_event_data` account.
- Size: with Stellar hook data the transaction is over 1232 bytes as a legacy
  transaction. Send it as a **v0 transaction with an address lookup table**
  holding the static accounts (config, fee wallet + its ATA, USDC mint,
  instructions sysvar, Circle PDAs and program ids). The test
  `bridge_tx_fits_with_address_lookup_table` pins this budget.

### `bridge` accounts (in order)

| Account | Notes |
| --- | --- |
| `user` | signer, writable. Must equal `quote.user`. Pays nonce + CCTP event rent and the SOL fee. |
| `config` | PDA `["config"]` |
| `nonce_record` | PDA `["nonce", quote.nonce]`, created here; a reused nonce fails to init |
| `burn_token_account` | user's USDC token account (mint = config USDC, authority = user) |
| `fee_wallet` | = `config.fee_wallet`, receives `native_fee` lamports |
| `fee_token_account` | ATA(fee_wallet, USDC); must already exist |
| `usdc_mint` | = `config.usdc_mint` (CCTP `burn_token_mint`) |
| `instructions` | `Sysvar1nstructions1111111111111111111111111` |
| `sender_authority_pda` ... `event_authority` | Circle's accounts, same derivation as `deriveCctpPdas` / `buildDepositForBurnIx` in `src/lib/solana/deposit-for-burn.ts`: `["sender_authority"]`, `["denylist_account", user]`, `["message_transmitter"]` (under MessageTransmitterV2), `["token_messenger"]`, `["remote_token_messenger", "<destDomain>"]`, `["token_minter"]`, `["local_token", usdc_mint]`, `message_sent_event_data` (fresh signer), MessageTransmitterV2 program, TokenMessengerMinterV2 program, SPL Token, System, `["__event_authority"]` |

Checks, in order: not paused; `now <= deadline`; nonce unused; `quote.user ==
user`; `source_domain == 5`; `amount > 0`; `settu_fee * 10_000 <= max_fee_bps
* amount` (u128); `network_fee <= max_network_fee`; `native_fee <=
max_native_fee`; burn `= amount - settu_fee - network_fee > 0`; the preceding
Ed25519SigVerify instruction covers the stored signer and these quote bytes.
Then: USDC `transfer_checked` of `settu_fee + network_fee` to the fee ATA,
system transfer of `native_fee` lamports to the fee wallet, CPI to Circle with
`destination_caller = 0`, and the `Bridged` event (Anchor `emit!`, i.e. a
`Program data:` log).

The program never holds funds. Nonce records are never closed (about 0.00095
SOL of rent per bridge, paid by the user).

### Owner instructions

`set_signer`, `set_fee_wallet`, `set_max_fee_bps` (≤ 10000),
`set_max_network_fee` (USDC atomic), `set_max_native_fee` (lamports),
`set_paused(bool)`, `transfer_ownership` + `accept_ownership` (two-step).

`initialize(signer, fee_wallet, max_fee_bps, max_network_fee, max_native_fee)`
can only be called by the program's **upgrade authority** (so nobody can
front-run it after deploy); that signer becomes the owner. Hand ownership to
the business owner's wallet with `transfer_ownership`, and consider moving or
removing the upgrade authority (the upgrade authority can replace the code,
so it is as powerful as the owner).

## Build and test

Needs anchor-cli 1.1.2, solana-cli 3.1.10 (`cargo build-sbf`), Rust 1.89
(`rust-toolchain.toml`).

```sh
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd contracts/solana/settu_bridge
anchor build --ignore-keys   # target/deploy/settu_bridge.so and mock_cctp.so
anchor test --skip-build     # cargo test (no validator); anchor test has no --ignore-keys
```

`--ignore-keys` is needed because `anchor build` generates a random
`target/deploy/mock_cctp-keypair.json` that can never match the mock's
`declare_id` (Circle's TokenMessengerMinterV2 id), and because the real
`settu_bridge` keypair is not in the repo. The program ids come from
`declare_id!`, so the built `.so` files are correct either way.

Tests run in-process on [LiteSVM](https://github.com/LiteSVM/litesvm) with
the real Ed25519SigVerify precompile. Circle's TokenMessengerMinterV2 is
replaced by `programs/mock_cctp`, loaded at Circle's program id: it has the
same instructions, the same 18 accounts and params as the vendored IDL
(`idls/token_messenger_minter_v2.json`, identical to
`src/lib/solana/idl/token_messenger_minter_v2.json`), mirrors Circle's checks
(signers, PDAs, owner of the burn account, denylist, `max_fee < amount`,
non-zero `mint_recipient`, non-empty hook data), burns the tokens and records
every argument. Unit tests pin the quote bytes to the golden vector and the
CPI discriminators / account layout / params to the IDL.

`mock_cctp` is TEST ONLY. Never deploy it; always deploy with
`anchor deploy -p settu_bridge`.

## Deploy (not done yet)

The program keypair is not in the repo. Copy it into the git-ignored
`target/deploy` first:

```sh
cp ~/.settu-bridge-testnet/solana-program-id.json target/deploy/settu_bridge-keypair.json
anchor build -p settu_bridge   # keys now match, no --ignore-keys
anchor deploy -p settu_bridge --provider.cluster devnet
```

Then call `initialize` from the upgrade authority with the devnet USDC mint
(`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), the ed25519 quote signer
public key, the fee wallet (its USDC ATA must exist), `max_fee_bps = 100`, and
the per-chain `max_network_fee` / `max_native_fee`. Verify Circle's program
ids against Circle's raw docs before mainnet.
