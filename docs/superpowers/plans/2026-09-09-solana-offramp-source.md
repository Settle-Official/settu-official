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

## Task 1: Solana connectivity + partial-sign smoke test — ✅ COMPLETE (2026-09-09)

**Purpose:** De-risk the two biggest unknowns before building anything: (a) Wallet Standard
detection + connect works for Phantom/Solflare in this app's context; (b) the wallet will
`signAndSendTransaction` a `VersionedTransaction` that **already carries** the event-keypair
signature (partial-sign). Also confirm devnet CCTP V2 `deposit_for_burn` lands end to end.

**Files:** `scripts/solana-cctp-smoke-test.mjs` (throwaway).

- [x] **Step 1:** `scripts/solana-cctp-smoke-test.mjs` — headless keypair run against devnet;
  builds a real `deposit_for_burn` (domain 6, dummy bytes32 mintRecipient, 0.1 USDC, standard/
  maxFee 0), generates the event keypair, signs `[wallet, eventKeypair]`, sends, polls sandbox
  Iris. Committed with the vendored V2 IDLs (`src/lib/solana/idl/`).

  **Dry-run done (2026-09-09):** Anchor 0.32 `Program(token_messenger_minter_v2 IDL)` +
  `.methods.depositForBurn(params).accounts({...}).instruction()` produces a valid **18-account**
  instruction (96 data bytes). Caller passes 9: `owner`, `eventRentPayer`, `burnTokenAccount`
  (USDC ATA), `messageTransmitter` = PDA(`message_transmitter`, MT), `tokenMessenger` =
  PDA(`token_messenger`, TMM), `remoteTokenMessenger` = PDA(`remote_token_messenger`, `"6"`, TMM),
  `tokenMinter` = PDA(`token_minter`, TMM), `burnTokenMint`, `messageSentEventData`. Anchor
  auto-resolves the rest from IDL seeds (`sender_authority_pda`, `denylist_account` [seed: owner],
  `local_token` [seed: mint], `event_authority`) + fixed program addresses. Two signers: wallet +
  event keypair. **The #1 risk (exact account layout) is retired** — matches Circle's own
  `examples/v2/solana.ts` + the on-chain IDL.

- [x] **Step 2:** **PASSED 2026-09-09.** Funded devnet wallet
  `FbgrhPZ6oACLnRLKtsdDgwWFfQW8CALJLiHsEuDCyzs4` (5 SOL, 20 devnet USDC). Burn confirmed:
  `3fqraNdKSh3rW7bur4AkibYoDszCMSBkNJAyztBw1xf7cVNrQ7jVaRDUys8KSvz3s7FSGbinugzY1uRJhro5CAX7`.
  Sandbox Iris (`/v2/messages/5?transactionHash=<sig>` — **query-param** form, the path form
  404s) returned `status: "complete"`, `cctpVersion: 2`, `sourceDomain 5 → destinationDomain 6`,
  `amount 100000`, `maxFee 0`, full attestation signature. Two-signer send (wallet + ephemeral
  event keypair) worked with a plain legacy `Transaction` + `sendAndConfirmTransaction`.
- [x] **Step 3:** **PASSED 2026-09-09.** `scripts/solana-partial-sign-harness.html` — Phantom
  (devnet) accepted a legacy `Transaction` that was `partialSign`ed with an ephemeral keypair
  first, then `signAndSendTransaction`'d by the wallet. Confirmed devnet tx
  `4sEWBUxb4sG7A9uzAqPfUzWAYqgPcg9yHhm8B2jvQz766B3BLwXcVxfeBnzViFji1zFqDTKbVzWXogtguwTwyPmR`.
  No fallback needed — the client-generates-keypair → server-builds → client-partial-signs →
  wallet-signs-and-sends split works.
- [x] **Step 4:** Recorded above. **Task 1 complete — all three de-risking goals met.**

---

## Task 2: Solana source config

**Files:** `src/lib/solana/config.ts`, `src/lib/solana/config.test.ts`

**Produces:** `SOLANA_CONFIG` (`{ messageTransmitterV2, tokenMessengerMinterV2, usdcMint,
cctpDomain: 5, usdcDecimals: 6, rpcUrl }`), `SOLANA_CCTP_DOMAIN = 5`, `isSolanaEnabled()`.

- [x] **Step 1:** Failing test — addresses are valid base58 `PublicKey`s, domain is 5, decimals 6.
- [x] **Step 2:** Config, mainnet/devnet keyed off `CCTP_NETWORK` (reuse existing var). Header
  comment records the two-source verification (Circle docs date + explorer URL per address).
  `rpcUrl` from `SOLANA_RPC_URL`, throws if unset.
- [x] **Step 3:** Pass. Add `SOLANA_RPC_URL` to `.env.example`.
- [x] **Step 4:** Commit.

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

- [x] **Step 1:** Vendor the V2 IDL (`src/lib/solana/idl/token-messenger-minter-v2.json`) from the
  on-chain program / Circle repo. Note its source + version in a header.
- [x] **Step 2:** Failing tests for the pure helpers (float→atomic, mintRecipient encoding, PDA
  derivation against known values from a devnet transaction).
- [x] **Step 3:** Implement. `destinationDomain` = 6, `destinationCaller` = `PublicKey.default`,
  `minFinalityThreshold` = 1000 (fast) / 2000 (standard).
- [x] **Step 4:** Pass. Commit.

---

## Task 4: `solana-build-tx` API route

**Files:** `src/app/api/offramp/bridge/solana-build-tx/route.ts`

**Consumes:** Task 2/3; `getBurnFeeQuote` + `computeAtomicFee` (`iris-client.ts`, domains `5 → 6`);
`withRetry` / `isNetworkFetchError` (`retry.ts`); `validateAmount`, `validateAddress(_, "base")`.
**Produces:** `POST { amount, ownerAddress (base58), toAddress (Base 0x), eventAccountPubkey (base58) }`
→ `{ transactionBase64, lastValidBlockHeight }` — an unsigned `VersionedTransaction`.

- [x] **Step 1:** Validate inputs. Reject if `!isSolanaEnabled()`.
- [x] **Step 2:** In a `withRetry` block: `Connection(SOLANA_RPC_URL)`; resolve owner USDC ATA;
  fee quote → `maxFee`; `buildDepositForBurnIx`; prepend a `SystemProgram.createAccount` (or the
  program's own event-account init, per the IDL) for `eventAccountPubkey` funded by `owner` with
  rent-exempt lamports for the MessageSent size; prepend `ComputeBudgetProgram` unit-limit +
  price ixs; recent blockhash; assemble `VersionedTransaction` (v0), serialize base64.
- [x] **Step 3:** `npx tsc --noEmit`. Manual devnet check: valid base64 back, deserialises,
  required signers = [owner, eventAccount].
- [x] **Step 4:** Commit.

---

## Task 5: `solana-balances` + SOL pre-flight

**Files:** `src/app/api/offramp/bridge/solana-balances/route.ts`

**Produces:** `GET ?address=` → `{ usdc: string, sol: string, sufficientForGas: boolean }`.
SOL floor ≈ `0.005` (base fee + priority + ~0.0015 rent for the event account). Read-only,
`withRetry`, mirrors `evm-balances` / `evm-gas-preflight`.

- [x] **Step 1:** Route: `Connection.getBalance` (SOL) + USDC ATA balance (tolerate missing ATA → 0).
- [x] **Step 2:** `tsc`. Manual check vs a real address.
- [x] **Step 3:** Commit.

---

## Task 6: Widen the shared offramp plumbing for "solana"

**Files (modify):** `src/lib/offramp/transaction-history.ts`, `src/app/api/offramp/bridge/register-transfer/route.ts`,
`src/app/api/offramp/bridge/gas-fee-options/route.ts`, `src/lib/cctp/evm-chains.ts` (the
`isChainEnabled` env-var rename), `.env.example`.

- [x] **Step 1:** `OfframpSourceChain` → `"stellar" | EvmChainKey | "solana"`. `funds-ledger.ts`
  widens for free.
- [x] **Step 2:** `register-transfer`: add a `resolvedSourceChain === "solana"` branch →
  `sourceDomain = 5`. Keep the existing idempotency + `recordTransaction` path. Manual check:
  a `sourceChain: "solana"` call resolves domain 5 (clean up the test record after, like the EVM
  task did).
- [x] **Step 3:** `gas-fee-options`: `sourceChain === "solana"` → domains `5 → 6`, 6-dp.
- [x] **Step 4:** Rename `NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED` →
  `NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED`; `isChainEnabled` reads the new name, falls back to
  the old for one release; accepts `"solana"`. Update `.env.example` + the shipped prod value
  (ops note in the plan, not code).
- [x] **Step 5:** `tsc && npm test`. Commit.

---

## Task 7: `useSolanaWallet` hook + Wallet Standard adapter

**Precondition:** Task 1 passed.

**Files:** `src/lib/solana/wallet-standard.ts`, `src/hooks/useSolanaWallet.ts`

**Produces:** `useSolanaWallet()` → `{ address: string | null; isConnected; isConnecting;
detectedWallets: { name; icon }[]; connect(name): Promise<void>; disconnect(): Promise<void>;
signAndSendBurn(transactionBase64: string, eventKeypair: Keypair): Promise<string> }` — same shape
family as `useEvmWallet`, no chain-switch.

- [x] **Step 1:** `wallet-standard.ts` — subscribe to `wallet-standard:register-wallet` +
  read the existing registry; expose wallets exposing `solana:signAndSendTransaction` (and
  `solana:signTransaction` as the Task-1 fallback path). Legacy `window.solana` fallback.
- [x] **Step 2:** Hook. `connect(name)` → wallet's `connect` feature → account address (base58).
  `signAndSendBurn` → deserialise, `tx.sign([eventKeypair])`, then wallet
  `signAndSendTransaction(tx)`; return signature.
- [x] **Step 3:** `tsc`. Commit.

---

## Task 8: Wallet picker, source dropdown, submission orchestration

**Files (modify):** `src/components/EvmConnectModal.tsx` → generalise to `OfframpConnectModal`
(or add a Solana section), `src/components/FormCard.tsx` (dropdown adds "Solana"),
`src/components/StellarampDashboard.tsx` (`handleExecuteSolanaTrade`, `useSolanaWallet`,
connect/disconnect routing, header/preflight props).

- [x] **Step 1:** `FormCard` `SOURCE_CHAIN_OPTIONS` gains `{ code: "solana", name: "Solana" }`
  when enabled. `OfframpSourceChainKey` includes `"solana"`.
- [x] **Step 2:** Connect modal: when `sourceChain === "solana"`, list `useSolanaWallet().detectedWallets`
  (Phantom/Solflare/Backpack) instead of the EVM/WalletConnect list.
- [x] **Step 3:** `StellarampDashboard`: `useSolanaWallet()` alongside the other two (still only one
  connected at a time — `handleSourceChainChange` tears down whichever). `headerUsesEvm` becomes
  `headerUsesExternal` covering both EVM and Solana.
- [x] **Step 4:** `handleExecuteSolanaTrade` — same shape as `handleExecuteEvmTrade`: Paycrest
  quote + order (shared), then: generate event `Keypair` client-side →
  `POST solana-build-tx { ..., eventAccountPubkey }` → `useSolanaWallet().signAndSendBurn(tx,
  eventKeypair)` → `registerEvmTransfer("/api/offramp/bridge/register-transfer", { burnTxHash: sig,
  mintRecipient, amount, paycrestOrderId, sourceChain: "solana", connectedAddress })` →
  `new EventSource(/api/offramp/bridge/stream/<sig>)` → same bridge+payout polling.
- [x] **Step 5:** Manual UI check (dropdown, connect, teardown on switch). Commit.

---

## Task 9: Header balances, progress label, fee display for Solana  

> Folded into Task 8 — the EVM UI was generalised rather than EVM-specific: externalBalances feeds the header (SOL/USDC) + FormCard USDC check, activeSourceChainLabel drives the "Submitting on Solana" step, and gas-fee-options?sourceChain=solana drives BRIDGE FEE (dev-verified 0.005 USDC on 50).

**Files (modify):** `src/components/StellarampDashboard.tsx`, `src/components/Header.tsx`,
`src/components/FormCard.tsx`

- [x] **Step 1:** Dashboard polls `solana-balances` when the Solana source is connected; feeds
  the header (USDC + `nativeCurrencyLabel="SOL"`) and FormCard's USDC check + SOL-gas gate.
- [x] **Step 2:** `TransactionProgressModal` `sourceChainLabel="Solana"`.
- [x] **Step 3:** `FormCard` BRIDGE FEE line uses `gas-fee-options?sourceChain=solana`.
- [x] **Step 4:** `tsc && npm test && npm run build`. Commit.

---

## Task 10: Rollout gate + staged live verification

- [x] **Step 1:** **PASSED 2026-09-09.** Full app flow on devnet: OFF-RAMP -> Solana -> Phantom (Wallet Standard) connect -> quote -> Paycrest order -> solana-build-tx -> client event-keypair partial-sign -> Phantom sign+broadcast -> burn confirmed on Solana devnet (sig 4zMnwAxdJQSHt1FhcYufGEX3apRTGghhiqB57vgu7hL8HU2p8eB4m9bGFgJuAvcSHxcS6BuUqLYVtirEKYsvJXXB). register-transfer accepted sourceChain:solana. Sandbox Iris: status complete, domain 5->6, amount 1000000, mintRecipient = the real Paycrest receive address. Stops here on testnet (no funded Base Sepolia minter / Paycrest watches mainnet).
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
