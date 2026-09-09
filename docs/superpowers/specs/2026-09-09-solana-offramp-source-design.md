# Solana Offramp Source Support — Design

**Status:** proposed (follow-up to `2026-09-08-multichain-offramp-source`, which is shipped).

**Goal:** Let offramp accept USDC burned from **Solana** (in addition to Stellar + the six EVM
chains), settling through the exact same Paycrest fiat-payout pipeline. The destination is always
Base; this concerns only the source side.

## Why this is a separate project, not "another chain"

The EVM feature's source-side machinery — `useEvmWallet` (EIP-6963 / WalletConnect `eip155`),
viem `encodeFunctionData` / `eth_sendTransaction`, `evm-chains.ts`, `evm-burn.ts`, every `evm-*`
route — is EVM-specific and none of it applies to Solana. Solana needs a parallel stack. What is
**already done** and needs zero change:

- **The Base-side mint.** `register-transfer` (Task 7 of the EVM plan) already accepts an arbitrary
  `sourceChain` / resolves an arbitrary `sourceDomain`; the attest→mint state machine on Base is
  domain-agnostic. Solana's CCTP domain is **5**.
- **Paycrest order creation + payout polling** in `StellarampDashboard` — identical.
- **`transaction-history.ts` / `funds-ledger.ts`** — only the `OfframpSourceChain` union widens.

## Verified facts (Circle raw docs, fetched 2026-09-09 — `developers.circle.com/cctp/solana-programs`)

- **CCTP domain:** `5` (mainnet and devnet).
- **Mainnet program IDs:**
  - `MessageTransmitterV2`: `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`
  - `TokenMessengerMinterV2`: `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`
  - (Devnet uses the **same** program IDs.)
- **USDC mint (Solana mainnet):** `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
  (devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEB4TrjCbR27r4d` — confirm against Circle before use).
- **Instruction:** `deposit_for_burn` on `TokenMessengerMinterV2` (V2). Params: `amount: u64`,
  `destinationDomain: u32` (= 6 for Base), `mintRecipient: Pubkey` (**the 32-byte left-padded
  hex Base address, base58-encoded**), `destinationCaller: Pubkey` (`PublicKey.default` ⇒
  permissionless), `maxFee: u64`, `minFinalityThreshold: u32` (1000 fast / 2000 standard, same as
  EVM). No hook needed (destination is Paycrest's Base address directly), so **not**
  `deposit_for_burn_with_hook`.
- **MessageSent event account (the Solana-specific wrinkle):** a fresh keypair generated
  **client-side**, passed into the instruction, and assigned to the `MessageTransmitterV2`
  program as owner. **It must sign the burn transaction.** So the burn tx has **two signers**:
  the user's wallet + this ephemeral keypair. It also needs rent-exemption lamports (~0.0015 SOL).
- IDLs are on-chain (`MessageTransmitterV2 IDL`, `TokenMessengerMinterV2 IDL`); reference
  implementation + example scripts at `github.com/circlefin/solana-cctp-contracts` (`examples/`).
- Decimals: Solana USDC is **6 dp** (same as EVM — the existing `usdcFloatToEvmInt` math applies).
- Devnet has full CCTP V2 → **testnet path exists**: Solana devnet → Base Sepolia.

**Before any address goes into committed config it must be independently re-verified against
Circle's docs AND a Solana explorer (Solscan / Solana Explorer program page)** — same two-source
standard as `constants.ts` and `evm-chains.ts`.

## Architecture

### Wallet connection — hand-rolled Wallet Standard, mirroring the EIP-6963 approach

Solana browser wallets (Phantom, Solflare, Backpack) implement the **Wallet Standard**
(`@wallet-standard/*` — the `wallet-standard:register-wallet` window event + a `wallets()`
registry), directly analogous to EIP-6963. We hand-roll detection the same way `injected.ts`
does for EVM, rather than pulling in the React-context-heavy `@solana/wallet-adapter-react`.

- `src/lib/solana/wallet-standard.ts` — subscribe to registered wallets, expose
  `{ name, icon, features }` + the `SolanaSignAndSendTransaction` / `SolanaSignTransaction`
  feature functions.
- `useSolanaWallet()` hook — same shape as `useEvmWallet`: `{ address, isConnected, isConnecting,
  connect(walletName), disconnect(), signAndSendBurn(tx) }`. No "switch chain" concept.
- `EvmConnectModal` generalises to an offramp-wide wallet picker, or a sibling
  `SolanaConnectModal` is added — TBD in the plan (leaning: one modal, source-chain-aware).

Legacy `window.solana` (Phantom) is the fallback when no Wallet-Standard wallet registers, same
as `injected.ts`'s `window.ethereum` fallback.

### Burn transaction — new deps, IDL-driven builder, split client/server

New dependencies (all first-party Solana, widely used):

- `@solana/web3.js` — `Connection`, `VersionedTransaction`, `PublicKey`, `Keypair`
- `@solana/spl-token` — the user's USDC associated token account
- `@coral-xyz/anchor` — decode the on-chain IDL and encode the `deposit_for_burn` instruction
  (hand-rolling borsh + ~12 PDA accounts is far more error-prone here than the EVM ABI encode)

**Client/server split** (mirrors EVM's "server builds, client signs", adapted for Solana's
constraints):

1. **Client** generates the MessageSent event `Keypair`, sends its **public key** + the amount +
   the Paycrest Base receive address to the server.
2. **Server** (`/api/offramp/bridge/solana-build-tx`):
   - derives every PDA (token_messenger, token_minter, local_token for USDC, sender_authority,
     message_transmitter, event_authority, …) from the program IDs
   - resolves the user's USDC ATA
   - fetches the CCTP fee quote (Circle Iris, `5 → 6`) and computes `maxFee`
   - builds the `deposit_for_burn` instruction (via the cached IDL) with the client's event-account
     pubkey as a signer, plus a `SystemProgram` rent transfer / `createAccount` for the event account
   - fetches a recent blockhash, assembles an unsigned `VersionedTransaction`, returns it base64
3. **Client** deserialises, **partial-signs with the event `Keypair`**, then hands it to the
   wallet (`signAndSendTransaction`), then polls confirmation.
4. **Client** calls the existing `register-transfer` with `sourceChain: "solana"`,
   `burnTxHash: <signature>`, `mintRecipient: <Base receive addr>`, `connectedAddress: <base58>`.

`maxFee` / `minFinalityThreshold` semantics are identical to EVM. `destinationCaller` = default.

### Config

- `src/lib/solana/config.ts` — program IDs, USDC mint, domain (5), decimals (6),
  mainnet/devnet switch keyed off `CCTP_NETWORK` (reuse the existing var).
- `SOLANA_RPC_URL` (server) — no public fallback, matching `BASE_RPC_URL`'s strict requirement.
  A dedicated RPC is required (public `api.mainnet-beta.solana.com` rate-limits hard).
- **Rollout gate:** rename `NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED` →
  `NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED` (keep reading the old name as a fallback for one
  release), and let it list `solana`. `isChainEnabled` grows to accept `"solana"`.

### Type changes

- `OfframpSourceChain` = `"stellar" | EvmChainKey | "solana"`.
- `funds-ledger.ts` `chain` field — already `"base" | OfframpSourceChain`, widens for free.
- `register-transfer` — add a `"solana"` branch resolving `sourceDomain = 5`. `isCctpBridgeChain`
  is EVM-only; Solana is its own case.
- Progress-modal `sourceChainLabel` — "Solana".

### Pre-flight

- `/api/offramp/bridge/solana-balances` — the wallet's USDC (SPL) + SOL balance.
- SOL gas check: Solana fees are ~0.000005 SOL + priority fee, **plus** ~0.0015 SOL rent for the
  MessageSent event account. Block "INITIATE OFFRAMP" when SOL balance is below a small floor
  (~0.005 SOL) with a clear message — mirrors the EVM `evm-gas-preflight` gate.
- Bridge fee: `gas-fee-options?sourceChain=solana` → domain `5 → 6` quote, 6-decimal formatting.

## Out of scope

- Solana as an **onramp destination** (Base → Solana) — separate, not requested.
- CCTP V1 / non-USDC.
- `deposit_for_burn_with_hook`.
- A Solana embedded/MPC wallet — external wallet only, user signs.

## Risks / unknowns to resolve during implementation

1. **Exact PDA seed list + account ordering for V2 `deposit_for_burn`.** Must be taken from the
   on-chain IDL / `circlefin/solana-cctp-contracts` `programs/v2/token-messenger-minter`, not
   guessed. This is the single biggest implementation risk.
2. **Wallet Standard partial-sign support.** Phantom/Solflare must accept a transaction that
   already carries the event-keypair signature. Confirmed possible in principle; verify with a
   devnet dry-run before building UI (a Task-1-style smoke test, like the WalletConnect one).
3. **Priority fees / compute budget.** `deposit_for_burn` is account-heavy; may need an explicit
   `ComputeBudgetProgram.setComputeUnitLimit` + priority fee to land reliably on mainnet.
4. **Bundle size.** `@solana/web3.js` + `@coral-xyz/anchor` is a real addition (~heavier than the
   EVM path). Lazy-load the Solana modules so a Stellar/EVM user doesn't download them.
