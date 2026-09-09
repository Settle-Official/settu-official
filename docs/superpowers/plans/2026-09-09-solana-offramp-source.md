# Solana Offramp Source Support — Implementation Plan

> Follow-up to `2026-09-08-multichain-offramp-source` (shipped). Implement task-by-task,
> checkbox tracking. Each address goes into committed config only after two-source verification
> (Circle docs + Solana explorer).

**Spec:** `docs/superpowers/specs/2026-09-09-solana-offramp-source-design.md`
**Branch:** `feat/solana-offramp-source` (off `main` @ `541b6f5`)

## Global constraints

- USDC only, CCTP V2 only, `deposit_for_burn` (no hook). Destination is always Base (domain 6).
- Solana CCTP domain is **5**. Programs (mainnet + devnet): `MessageTransmitterV2`
  `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC`, `TokenMessengerMinterV2`
  `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe`. Re-verify before committing.
- No server-held key. The user's Solana wallet signs; the server only builds an unsigned tx.
  The one exception is the ephemeral **MessageSent event keypair**, generated client-side and
  co-signing the burn — never persisted.
- The exact PDA seeds + account ordering for V2 `deposit_for_burn` MUST come from
  `github.com/circlefin/solana-cctp-contracts` (`programs/v2/`) or the on-chain IDL — never guessed.
- Lazy-load all `@solana/*` + `@coral-xyz/anchor` modules so Stellar/EVM users don't pay the bundle.
- Nothing in the Stellar or EVM paths changes behaviour — Solana is a parallel branch.
- Task 1 (smoke test) must pass before Tasks 7+ (wallet hook / UI).

---

## Task 1: Solana connectivity + partial-sign smoke test

**Purpose:** De-risk the two biggest unknowns before building anything: (a) Wallet Standard
detection + connect works for Phantom/Solflare in this app's context; (b) the wallet will
`signAndSendTransaction` a `VersionedTransaction` that **already carries** the event-keypair
signature (partial-sign). Also confirm devnet CCTP V2 `deposit_for_burn` lands end to end.

**Files:** `scripts/solana-cctp-smoke-test.mjs` (throwaway).

- [ ] **Step 1:** Script that, against **devnet**: connects a wallet (or takes a keypair path for
  headless run), builds a minimal `deposit_for_burn` (domain 6, a dummy 32-byte mintRecipient,
  1 USDC), generates the event keypair, partial-signs, sends, prints the signature.
- [ ] **Step 2:** Run it with a funded devnet wallet holding devnet USDC + SOL. Confirm the tx
  lands and Circle's devnet Iris (`iris-api-sandbox.circle.com`) returns an attestation for it.
- [ ] **Step 3:** Repeat the sign step through a real browser wallet (Phantom devnet) via a tiny
  HTML harness — confirm partial-signed tx is accepted. **If a wallet rejects the pre-signed
  event account, stop** and revisit the split (fallback: wallet signs first via `signTransaction`,
  then client adds the event sig, then client submits raw — needs `signTransaction` feature).
- [ ] **Step 4:** Record outcome in this file. Commit the script.

---

## Task 2: Solana source config

**Files:** `src/lib/solana/config.ts`, `src/lib/solana/config.test.ts`

**Produces:** `SOLANA_CONFIG` (`{ messageTransmitterV2, tokenMessengerMinterV2, usdcMint,
cctpDomain: 5, usdcDecimals: 6, rpcUrl }`), `SOLANA_CCTP_DOMAIN = 5`, `isSolanaEnabled()`.

- [ ] **Step 1:** Failing test — addresses are valid base58 `PublicKey`s, domain is 5, decimals 6.
- [ ] **Step 2:** Config, mainnet/devnet keyed off `CCTP_NETWORK` (reuse existing var). Header
  comment records the two-source verification (Circle docs date + explorer URL per address).
  `rpcUrl` from `SOLANA_RPC_URL`, throws if unset.
- [ ] **Step 3:** Pass. Add `SOLANA_RPC_URL` to `.env.example`.
- [ ] **Step 4:** Commit.

---

## Task 3: `deposit_for_burn` instruction builder

**Files:** `src/lib/solana/deposit-for-burn.ts`, `src/lib/solana/deposit-for-burn.test.ts`

**Consumes:** `SOLANA_CONFIG` (Task 2); `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`.
**Produces:**
- `usdcFloatToSolanaAtomic(amount: string): bigint` — 6-dp, identical math to `usdcFloatToEvmInt`.
- `baseAddressToSolanaMintRecipient(addr: \`0x${string}\`): PublicKey` — left-pad to 32 bytes,
  wrap as `PublicKey`. Unit-tested against a known vector.
- `deriveCctpPdas(): { ... }` — every PDA the instruction needs, from program IDs + seeds taken
  from Circle's V2 program source. Unit-tested (deterministic, no RPC).
- `buildDepositForBurnIx(params: { owner: PublicKey; ownerUsdcAta: PublicKey; amountAtomic: bigint;
  mintRecipient: PublicKey; maxFeeAtomic: bigint; eventAccount: PublicKey; fast?: boolean }):
  TransactionInstruction` — the unsigned instruction, IDL-encoded.

- [ ] **Step 1:** Vendor the V2 IDL (`src/lib/solana/idl/token-messenger-minter-v2.json`) from the
  on-chain program / Circle repo. Note its source + version in a header.
- [ ] **Step 2:** Failing tests for the pure helpers (float→atomic, mintRecipient encoding, PDA
  derivation against known values from a devnet transaction).
- [ ] **Step 3:** Implement. `destinationDomain` = 6, `destinationCaller` = `PublicKey.default`,
  `minFinalityThreshold` = 1000 (fast) / 2000 (standard).
- [ ] **Step 4:** Pass. Commit.

---

## Task 4: `solana-build-tx` API route

**Files:** `src/app/api/offramp/bridge/solana-build-tx/route.ts`

**Consumes:** Task 2/3; `getBurnFeeQuote` + `computeAtomicFee` (`iris-client.ts`, domains `5 → 6`);
`withRetry` / `isNetworkFetchError` (`retry.ts`); `validateAmount`, `validateAddress(_, "base")`.
**Produces:** `POST { amount, ownerAddress (base58), toAddress (Base 0x), eventAccountPubkey (base58) }`
→ `{ transactionBase64, lastValidBlockHeight }` — an unsigned `VersionedTransaction`.

- [ ] **Step 1:** Validate inputs. Reject if `!isSolanaEnabled()`.
- [ ] **Step 2:** In a `withRetry` block: `Connection(SOLANA_RPC_URL)`; resolve owner USDC ATA;
  fee quote → `maxFee`; `buildDepositForBurnIx`; prepend a `SystemProgram.createAccount` (or the
  program's own event-account init, per the IDL) for `eventAccountPubkey` funded by `owner` with
  rent-exempt lamports for the MessageSent size; prepend `ComputeBudgetProgram` unit-limit +
  price ixs; recent blockhash; assemble `VersionedTransaction` (v0), serialize base64.
- [ ] **Step 3:** `npx tsc --noEmit`. Manual devnet check: valid base64 back, deserialises,
  required signers = [owner, eventAccount].
- [ ] **Step 4:** Commit.

---

## Task 5: `solana-balances` + SOL pre-flight

**Files:** `src/app/api/offramp/bridge/solana-balances/route.ts`

**Produces:** `GET ?address=` → `{ usdc: string, sol: string, sufficientForGas: boolean }`.
SOL floor ≈ `0.005` (base fee + priority + ~0.0015 rent for the event account). Read-only,
`withRetry`, mirrors `evm-balances` / `evm-gas-preflight`.

- [ ] **Step 1:** Route: `Connection.getBalance` (SOL) + USDC ATA balance (tolerate missing ATA → 0).
- [ ] **Step 2:** `tsc`. Manual check vs a real address.
- [ ] **Step 3:** Commit.

---

## Task 6: Widen the shared offramp plumbing for "solana"

**Files (modify):** `src/lib/offramp/transaction-history.ts`, `src/app/api/offramp/bridge/register-transfer/route.ts`,
`src/app/api/offramp/bridge/gas-fee-options/route.ts`, `src/lib/cctp/evm-chains.ts` (the
`isChainEnabled` env-var rename), `.env.example`.

- [ ] **Step 1:** `OfframpSourceChain` → `"stellar" | EvmChainKey | "solana"`. `funds-ledger.ts`
  widens for free.
- [ ] **Step 2:** `register-transfer`: add a `resolvedSourceChain === "solana"` branch →
  `sourceDomain = 5`. Keep the existing idempotency + `recordTransaction` path. Manual check:
  a `sourceChain: "solana"` call resolves domain 5 (clean up the test record after, like the EVM
  task did).
- [ ] **Step 3:** `gas-fee-options`: `sourceChain === "solana"` → domains `5 → 6`, 6-dp.
- [ ] **Step 4:** Rename `NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED` →
  `NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED`; `isChainEnabled` reads the new name, falls back to
  the old for one release; accepts `"solana"`. Update `.env.example` + the shipped prod value
  (ops note in the plan, not code).
- [ ] **Step 5:** `tsc && npm test`. Commit.

---

## Task 7: `useSolanaWallet` hook + Wallet Standard adapter

**Precondition:** Task 1 passed.

**Files:** `src/lib/solana/wallet-standard.ts`, `src/hooks/useSolanaWallet.ts`

**Produces:** `useSolanaWallet()` → `{ address: string | null; isConnected; isConnecting;
detectedWallets: { name; icon }[]; connect(name): Promise<void>; disconnect(): Promise<void>;
signAndSendBurn(transactionBase64: string, eventKeypair: Keypair): Promise<string> }` — same shape
family as `useEvmWallet`, no chain-switch.

- [ ] **Step 1:** `wallet-standard.ts` — subscribe to `wallet-standard:register-wallet` +
  read the existing registry; expose wallets exposing `solana:signAndSendTransaction` (and
  `solana:signTransaction` as the Task-1 fallback path). Legacy `window.solana` fallback.
- [ ] **Step 2:** Hook. `connect(name)` → wallet's `connect` feature → account address (base58).
  `signAndSendBurn` → deserialise, `tx.sign([eventKeypair])`, then wallet
  `signAndSendTransaction(tx)`; return signature.
- [ ] **Step 3:** `tsc`. Commit.

---

## Task 8: Wallet picker, source dropdown, submission orchestration

**Files (modify):** `src/components/EvmConnectModal.tsx` → generalise to `OfframpConnectModal`
(or add a Solana section), `src/components/FormCard.tsx` (dropdown adds "Solana"),
`src/components/StellarampDashboard.tsx` (`handleExecuteSolanaTrade`, `useSolanaWallet`,
connect/disconnect routing, header/preflight props).

- [ ] **Step 1:** `FormCard` `SOURCE_CHAIN_OPTIONS` gains `{ code: "solana", name: "Solana" }`
  when enabled. `OfframpSourceChainKey` includes `"solana"`.
- [ ] **Step 2:** Connect modal: when `sourceChain === "solana"`, list `useSolanaWallet().detectedWallets`
  (Phantom/Solflare/Backpack) instead of the EVM/WalletConnect list.
- [ ] **Step 3:** `StellarampDashboard`: `useSolanaWallet()` alongside the other two (still only one
  connected at a time — `handleSourceChainChange` tears down whichever). `headerUsesEvm` becomes
  `headerUsesExternal` covering both EVM and Solana.
- [ ] **Step 4:** `handleExecuteSolanaTrade` — same shape as `handleExecuteEvmTrade`: Paycrest
  quote + order (shared), then: generate event `Keypair` client-side →
  `POST solana-build-tx { ..., eventAccountPubkey }` → `useSolanaWallet().signAndSendBurn(tx,
  eventKeypair)` → `registerEvmTransfer("/api/offramp/bridge/register-transfer", { burnTxHash: sig,
  mintRecipient, amount, paycrestOrderId, sourceChain: "solana", connectedAddress })` →
  `new EventSource(/api/offramp/bridge/stream/<sig>)` → same bridge+payout polling.
- [ ] **Step 5:** Manual UI check (dropdown, connect, teardown on switch). Commit.

---

## Task 9: Header balances, progress label, fee display for Solana

**Files (modify):** `src/components/StellarampDashboard.tsx`, `src/components/Header.tsx`,
`src/components/FormCard.tsx`

- [ ] **Step 1:** Dashboard polls `solana-balances` when the Solana source is connected; feeds
  the header (USDC + `nativeCurrencyLabel="SOL"`) and FormCard's USDC check + SOL-gas gate.
- [ ] **Step 2:** `TransactionProgressModal` `sourceChainLabel="Solana"`.
- [ ] **Step 3:** `FormCard` BRIDGE FEE line uses `gas-fee-options?sourceChain=solana`.
- [ ] **Step 4:** `tsc && npm test && npm run build`. Commit.

---

## Task 10: Rollout gate + staged live verification

- [ ] **Step 1:** Devnet end-to-end: Solana devnet → Base Sepolia. Real devnet USDC, a real
  Phantom connect, full path incl. attestation + mint + a (sandbox) Paycrest order if feasible,
  else stop at confirmed mint on Base Sepolia at the expected recipient.
- [ ] **Step 2:** Enable `solana` in `NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED` +
  `SOLANA_RPC_URL` in production; redeploy.
- [ ] **Step 3:** One real small-amount ($1–2) mainnet offramp from Solana: connect Phantom →
  approve the burn (two signers) → attestation → mint on Base → Paycrest settles to a bank →
  `offramp:tx:<sig>` shows `status:"completed"`, `sourceChain:"solana"`.
- [ ] **Step 4:** Record chains + dates verified in this file. Open PR `feat/solana-offramp-source`
  → `main` (no co-author trailer, no generated-by footer). Do not self-merge.

---

## New dependencies

`@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor` — all first-party Solana, lazy-loaded.
No Solana wallet-adapter React package (Wallet Standard hand-rolled, per the EIP-6963 precedent).

## New env vars

- `SOLANA_RPC_URL` (server, required, no public fallback)
- `NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED` (renamed from `…_EVM_SOURCE_CHAINS_ENABLED`; old
  name honoured as fallback for one release)
