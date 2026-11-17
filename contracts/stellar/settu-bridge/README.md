# settu-bridge (Stellar / Soroban)

Bridges a Stellar user's USDC through Circle CCTP V2 in **one invocation**:

1. verifies a Settu-signed ed25519 quote (`env.crypto().ed25519_verify`),
2. moves `settu_fee + network_fee` USDC from the user to `fee_wallet`, plus
   exactly `native_fee` stroops of XLM through the native XLM Stellar Asset
   Contract when `native_fee > 0`,
3. burns `amount - settu_fee - network_fee` through Circle's
   TokenMessengerMinterV2 `deposit_for_burn` (or `deposit_for_burn_with_hook`
   when `hook_data` is non-empty), with the user as depositor and
   `destination_caller = 0`,
4. emits `("bridged", nonce)` → `(user, amount, settu_fee, network_fee,
   native_fee, dest_domain, mint_recipient, min_finality)`.

The contract never holds funds. Spec: `docs/superpowers/specs/2026-11-16-user-bridge-design.md` §5, §5.2.

## Circle interface

From [circlefin/stellar-cctp](https://github.com/circlefin/stellar-cctp) at
commit `45746f2c803198bc6cd586475eb3c925f12bb488`:

- `packages/cctp-interfaces/src/token_messenger.rs`: the `TokenMessenger` trait
  (copied verbatim into `src/lib.rs` as a `#[contractclient]`).
- `contracts/token-messenger-minter-v2/src/contract.rs`: `caller.require_auth()`
  plus a denylist check on both entry points.
- `contracts/token-messenger-minter-v2/src/deposit.rs`: `transfer_from(messenger,
  caller, messenger, local_amount)` then `burn`. The pull goes through an
  **allowance**. Circle burns only multiples of 10 (7 → 6 decimals), so this
  contract rejects any burn amount that isn't one (`BurnAmountHasDust`).

## Auth model

The signature is
`bridge(user, quote, signature, approve_expiration_ledger: u32)`. The user
signs one auth entry for it, and its tree holds these sub-invocations:

| sub-invocation | why |
| --- | --- |
| `usdc.transfer(user, fee_wallet, settu_fee + network_fee)` | USDC fee (skipped if 0) |
| `xlm.transfer(user, fee_wallet, native_fee)` | native fee (skipped if 0) |
| `usdc.approve(user, messenger, burn, approve_expiration_ledger)` | the allowance Circle's `transfer_from` needs |
| `messenger.deposit_for_burn[_with_hook](user, burn, …)` | Circle's `caller.require_auth()` |

RPC simulation records this tree automatically. **No separate approve
transaction is needed**, so the bridge doesn't use the offramp's
`checkStellarUsdcAllowance` / `buildApproveUsdcTx`.

**`approve_expiration_ledger`** is chosen by the client when it builds the
transaction. A sensible value is the latest ledger plus 100. It is **not**
part of the signed quote, but it is a `bridge` argument, so it is covered by
the user's auth. It has to be a fixed argument: the approve's arguments are
part of the signed auth tree, so an expiry derived on-chain from "the current
ledger" would differ between simulation and execution and break every real
transaction. The contract requires
`current ≤ approve_expiration_ledger ≤ current + 1,000`, or it returns
`BadApproveExpiry`.

> **Known behaviour for integrators:** the approve **replaces** any existing
> user → TokenMessengerMinter USDC allowance, because SEP-41 `approve` sets the
> allowance rather than adding to it. After a bridge, that allowance is **0**:
> Circle consumes all of it, since the burn amount must be dust-free. The
> offramp flow already re-checks the allowance and re-approves when it's too
> low. Any other integration that relies on a standing allowance to Circle's
> messenger must do the same.

## Quote message

The quote message must match `encodeQuoteBytes(…, "stellar", contractId)` in
`src/lib/bridge/quote.ts` exactly. All integers are big-endian:

```
"SETTU_BRIDGE_V1" | contractId 32 | sourceDomain u32 | destDomain u32 | user 32 |
amount u64 | settuFee u64 | networkFee u64 | nativeFee u64 | mintRecipient 32 |
maxFee u64 | minFinality u32 | deadline u64 | nonce 32 | hookDataLen u32 | hookData
```

`contractId` is this contract's own id, taken from `current_contract_address()`.
The `stellar` case in `contracts/test-vectors/quotes.json` pins the encoding,
and the tests run that vector end to end at its exact contract id.

Units (Ruling J): `amount`, `settu_fee`, `network_fee` and `max_fee` are in
Stellar USDC's 7-decimal units. `native_fee` is in stroops. Values are i128
on-chain and u64 when signed, so any value that is negative or above u64::MAX
is rejected.

## Checks (in order)

1. The contract isn't paused.
2. `now <= deadline`, and `deadline - now <= 3600 s`.
3. The nonce is unused.
4. The user is a G-account, and its key equals `quote.user`.
5. `source_domain` equals `local_domain` (27).
6. Every amount is in range, and `amount > 0`.
7. `settu_fee * 10_000 <= max_fee_bps * amount`.
8. `network_fee <= max_network_fee`.
9. `native_fee <= max_native_fee`.
10. The fees are less than `amount`.
11. The burn amount (`amount − fees`) is a multiple of 10 (`BurnAmountHasDust`).
12. `current ≤ approve_expiration_ledger ≤ current + 1,000` (`BadApproveExpiry`).
13. The ed25519 signature is valid against `signer`.

A bad signature makes the host trap with a crypto error, not a Settu error
code.

Settu error codes start at **9101**, so they can't collide with errors from
nested calls: the SAC uses 1–13 and Circle uses 7100 and up.

## Nonce TTL

Used nonces sit in persistent storage. Archiving never deletes a persistent
entry: an archived entry has to be restored, still present, before anyone can
read it. Each nonce is also extended to at least 17,280 ledgers, about a day.
Since a quote can live at most 3,600 s, its nonce outlives it even if ledgers
closed every second. The server uses 120 s deadlines.

## Owner

The admin passed to `__constructor` is the owner. The owner-only functions
are `set_signer`, `set_fee_wallet`, `set_max_fee_bps` (≤ 10,000; starts at
100), `set_max_network_fee`, `set_max_native_fee`, `pause`, `unpause` and
`transfer_ownership`. Each one calls `require_auth` on the owner.
`transfer_ownership` is two-step: the nominee must call `accept_ownership`.
There's no way to renounce ownership.

Each owner function emits an audit event, matching the EVM contract:

| Event | Topics | Data |
| --- | --- | --- |
| Signer changed | `signer_updated` | `(previous, current)` |
| Fee wallet changed | `fee_wallet_updated` | `(previous, current)` |
| Max fee bps changed | `max_fee_bps_updated` | `(previous, current)` |
| Max network fee changed | `max_network_fee_updated` | `(previous, current)` |
| Max native fee changed | `max_native_fee_updated` | `(previous, current)` |
| Paused | `paused` | `owner` |
| Unpaused | `unpaused` | `owner` |
| Ownership transfer started | `ownership_transfer_started`, `previous`, `pending` | none |
| Ownership transferred | `ownership_transferred`, `previous`, `current` | none |

## Build and test

```sh
cargo test               # 54 tests: mock Circle messenger, real SACs, golden vector
stellar contract build   # → target/wasm32v1-none/release/settu_bridge.wasm
```

The tests use the real built-in SACs for USDC and native XLM, with classic
G-accounts and trustlines. A mock messenger mirrors Circle's
`require_auth` → `transfer_from` → `burn` flow, including dust normalisation.
The mock also mirrors these checks from Circle, with Circle's error codes:
`amount > 0`, a non-zero mint recipient, `max_fee ≥ 0`, a missing decimal
config (7120), `BurnAmountTooSmall`, canonical `max_fee < amount` (7104), and a
configurable minimum fee (`InsufficientMaxFee`, 7105, using Circle's formula).
Tests show that each of these reverts the whole bridge, leaving the nonce
unused and no fees moved.

Real `SorobanAuthorizationEntry`s are signed with the user's account key, with
no auth mocking. They show that one signed tree is enough, and that a tree
signed at ledger N still executes at N+1 and N+50.

### Testnet gate: what the mock can't reproduce

Verify these against Circle's real TokenMessengerMinter on testnet before
mainnet:

- the **denylist** (`require_not_denylisted(caller)`)
- the messenger's own **pause** (`#[when_not_paused]`)
- remote token-messenger registration for the destination domain
  (`NoTokenMessengerForDomain`)
- the per-message burn limit (`enforce_within_burn_limit`)
- the real minimum fee value Circle sets
- the MessageTransmitter `send_message` and its finality rules
- that RPC simulation records exactly the auth tree above

## Deploy

The constructor takes `(admin, usdc, token_messenger, local_domain = 27,
signer: BytesN<32>, fee_wallet, native_token = native XLM SAC, max_network_fee,
max_native_fee)`. Nothing has been deployed yet.
