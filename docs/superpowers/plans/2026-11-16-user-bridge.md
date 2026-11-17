# User Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Settu users bridge USDC between any two of 8 chains (Stellar, Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon, Solana) over Circle CCTP V2.
- The user signs once on the source chain.
- A Settu contract takes the fee in the same transaction.
- Settu delivers on the destination.

**Architecture:**
- **Contracts:** a small Settu bridge contract per chain family (Solidity on 6 EVM chains, Soroban on Stellar, Anchor on Solana). Each verifies a server-signed quote, moves the fee to Settu's fee wallet, and burns the rest through CCTP.
- **Server:** Next.js routes build quotes and source transactions, register bridges, and drive burn → attest → mint on the server (QStash callbacks plus the existing 5-minute sweep). They reuse `src/lib/cctp/*`.
- **UI:** `/app/bridge` reuses the offramp's components.

**Tech Stack:**
- **App:** Next.js 15 App Router, TypeScript, viem, `@stellar/stellar-sdk`, `@coral-xyz/anchor` + `@solana/web3.js`, Upstash Redis + QStash
- **Contracts:** Foundry (Solidity), Soroban Rust SDK, Anchor
- **Tests:** `node --test` via `npm test`

**Spec:** `docs/superpowers/specs/2026-11-16-user-bridge-design.md`. Read it before any task. Section numbers below (§n) refer to it. UI must match `docs/superpowers/specs/assets/2026-11-16-user-bridge-mockup.html`.

## Global Constraints

**Branch and release**
- All work happens on `feat/user-bridge`. Push to the remote. **Never open a PR into `main`, never deploy production.**
- No `Co-Authored-By` or "Generated with" lines in commits.

**Networks and addresses**
- Use **testnets only**: `CCTP_NETWORK=testnet`. Mainnet contract deployment is out of scope until an audit (§12).
- Copy every contract address and CCTP domain verbatim from Circle's raw docs (fetch with curl, not a summary), then cross-check on the chain's explorer.

| Chain | CCTP domain |
|---|---|
| Ethereum | 0 |
| Avalanche | 1 |
| Optimism | 2 |
| Arbitrum | 3 |
| Solana | 5 |
| Base | 6 |
| Polygon | 7 |
| Stellar | 27 |

- Finality threshold: Fast = 1000, Standard = 2000 (`FINALITY_THRESHOLD`).
- USDC decimals: 6 on EVM and Solana, 7 on Stellar. Amounts leaving Stellar must be multiples of 10 Stellar units.

**Fees and quotes**
- Platform fee by speed: **Standard 30 bps (0.3%)**, **Fast 60 bps (0.6%)** (team review 2026-11-17). It's one setting per speed for every route, and each must be ≤ the lowest on-chain cap.
- On Fast, Circle's Fast fee (`maxFee`) is paid out of the 0.6%. **The UI shows no Fast-fee line.**
- The network fee is paid either **from USDC** (`networkFee`, the default) or **in the source chain's native token in the same transaction** (`nativeFee`). The user chooses.
- On-chain limits (owner wallet only, never a server key):
  - `maxFeeBps` (starts at 100 bps, 1%), which caps **`settuFee` only**
  - `maxNetworkFee` (absolute USDC)
  - `maxNativeFee` (absolute native units)
- Quote lifetime: **120 s**. Each nonce is single-use, enforced on-chain.
- Contracts store only the signer key, the fee wallet, the cap, the used nonces and the paused flag. They hold no USDC after a call. `destinationCaller` is always zero.

**Delivery and polling**
- Self-claim is offered **30 minutes after attestation**.
- The client polls status every **5 s, only while `document.visibilityState === "visible"`**, and stops at a final status or after **20 minutes**.
- **No SSE / EventSource** anywhere in the bridge.

**UI copy, verbatim**

| Element | Text |
|---|---|
| Stepper steps | "Confirm transaction in wallet", "Sending from {source}", "Verifying the transfer", "Delivering on {destination}", "Arrived in your wallet" (EVM without permit adds "Approve USDC" first) |
| Paste warning | "Check this address carefully. Bridged USDC can't be recalled or redirected. If this isn't your {chain} address, the funds are lost for good." |
| Receive headline | "You'll receive on {chain}", prefixed "at least" for Fast |
| Fee lines | "You send", "Settu fee (0.3%)" / "Settu fee (0.6%)", "Network fee on {chain}" showing "{x} USDC" or "{y} {native} (paid separately)", "Estimated time". **No Fast-fee line.** |
| Network fee switch | "From my USDC" / "In {native symbol}"; disabled with "Not enough {native}" when the source wallet can't cover gas plus `nativeFee` |
| No-quote message | "Couldn't get a price right now — try again in a moment" |
| Fallback to Standard | "Taking the standard route — still on its way" |
| Stellar secret key pasted | "That's a secret key — never paste it anywhere" |

**Rendering**
- Use the app's existing components: `AppSelect`, `FormCard` field/label classes, `FlowModal`, `ResultCard`. Inline `style={{border}}` / `backgroundColor` on `<button>` (globals.css resets button bg/border).

## Review Focus

These are inputs the spec implies but which are easy to get wrong. The test that pins each one lives in the task named in brackets.

1. **The quote expires while the wallet is open:** the user sees a fresh breakdown and confirms again, and never gets an on-chain revert they can't explain. [Task 20]
2. **A Stellar amount with a 7th decimal** (e.g. `10.1234567`): the quote rounds down to a multiple of 10 units and shows the new amount. It never silently differs from what the user typed. [Task 4]
3. **A Solana USDC token account pasted instead of a wallet address:** rejected with a message saying to paste the wallet address. [Task 2]
4. **The tab closes between signing and registration:** the bridge still completes, through the event sweep. [Task 15]
5. **The destination relayer is out of gas:** the bridge waits and an alert fires. It's never marked failed for that reason, and it completes after a top-up. [Task 14]

---

## Phase 1: Shared foundations (pure TypeScript)

### Task 1: Bridge chain registry

**Files:**
- Create: `src/lib/bridge/chains.ts`
- Modify: `src/lib/cctp/constants.ts` (extend `CCTP_DOMAIN` with all 8)
- Test: `src/lib/bridge/chains.test.ts`

**Interfaces:**
- Produces:
  - `type BridgeChainKey = "stellar" | "ethereum" | "base" | "arbitrum" | "optimism" | "avalanche" | "polygon" | "solana"`
  - `type ChainFamily = "evm" | "stellar" | "solana"`
  - `interface BridgeChain { key; label; family; cctpDomain: number; usdcDecimals: 6 | 7; usdc: string; chainId?: number; rpcEnvVar: string; nativeSymbol: string; explorerTx(hash: string): string }`
  - `BRIDGE_CHAINS: Record<BridgeChainKey, BridgeChain>`
  - `bridgeChainByDomain(domain: number): BridgeChain`
  - `BRIDGE_CHAIN_OPTIONS: { code: BridgeChainKey; name: string }[]`, in UI order: Solana, Base, Stellar, Ethereum, Arbitrum, Optimism, Avalanche, Polygon. This is the shape `AppSelect` expects.
- EVM entries reuse addresses from `src/lib/cctp/evm-chains.ts`. Don't duplicate them; import.

- [ ] **Step 1: Write the failing tests:**
  - `domains match Circle`: each key's `cctpDomain` equals the Global Constraints table.
  - `decimals`: stellar 7, all others 6.
  - `family`: the 6 EVM chains are `evm`.
  - `options order and length 8`.
  - `bridgeChainByDomain(27).key === "stellar"`, and it throws on 99.
- [ ] **Step 2:** `npm test` → FAIL (module missing).
- [ ] **Step 3:** Implement `chains.ts`. Testnet and mainnet values switch on `CCTP_NETWORK`, as `constants.ts` does.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit: `feat(bridge): chain registry for all 8 CCTP chains`.

### Task 2: Destination address validation (format and static rules)

**Files:**
- Create: `src/lib/bridge/address.ts`
- Test: `src/lib/bridge/address.test.ts`

**Interfaces:**
- Produces: `validateDestinationAddress(chain: BridgeChainKey, input: string): AddressCheck` where `type AddressCheck = { ok: true; address: string } | { ok: false; code: AddressErrorCode; message: string }`.
- `AddressErrorCode` = `"empty" | "wrong_family" | "bad_format" | "bad_checksum" | "secret_key" | "muxed" | "contract" | "forbidden" | "token_account"`.
- It's synchronous and pure: no network. The network checks are in Task 11.
- `address` is normalised: EIP-55 for EVM, the trimmed input otherwise.

- [ ] **Step 1: Write the failing tests**, one per rule from spec §8:
  - **EVM:** a valid mixed-case EIP-55 address → ok, checksummed. An all-lowercase valid address → ok. A mixed-case address with one wrong case → `bad_checksum`. 39 hex chars → `bad_format`.
  - **Wrong family:** pasting `G…` for base → `wrong_family`, message `"That's a Stellar address. Base needs an address starting with 0x."`. Pasting `0x…` for solana → `wrong_family`, message naming Ethereum-style and Solana.
  - **Solana:** a valid base58 32-byte key → ok. Base58 decoding to 31 bytes → `bad_format`.
  - **Stellar:** a valid `G…` → ok. A bad checksum → `bad_checksum`. `S…` → `secret_key`, message exactly `"That's a secret key — never paste it anywhere"`. `M…` → `muxed`. `C…` → `contract`.
  - **Forbidden:** for every chain, the zero address (EVM), that chain's USDC address, the CCTP TokenMessenger/MessageTransmitter, and any address in `BRIDGE_FORBIDDEN_ADDRESSES` (exported, filled in Task 9) → `forbidden`.
  - **Whitespace:** leading and trailing spaces are trimmed, and the result is ok.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement with viem `getAddress`/`isAddress`, `@stellar/stellar-sdk` `StrKey`, and `bs58` (already a transitive dependency of `@solana/web3.js`; import `PublicKey` instead if simpler).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit: `feat(bridge): destination address validation`.

### Task 3: Fee setting

**Files:**
- Create: `src/lib/bridge/fee-settings.ts`
- Test: `src/lib/bridge/fee-settings.test.ts`

**Interfaces:**
- Produces:
  - `DEFAULT_BRIDGE_FEE_BPS = 50`
  - `DEFAULT_FEE_CAP_BPS = 100`
  - `validateFeeBps(bps: number, lowestCapBps: number): string | null`, which returns an error message or null
  - `getBridgeFeeBps(): Promise<number>` (Redis key `bridge:fee-bps`, falling back to the default)
  - `setBridgeFeeBps(bps: number, actor: string, lowestCapBps: number): Promise<void>`, which writes the value and pushes `{at, actor, from, to}` to the list `bridge:fee-bps:audit`, capped at 200 entries
- Redis client pattern: lazy `new Redis({ url, token })`, as in `src/lib/notify/gas-alert.ts` on `feat/hot-wallet-gas-alert`.

- [ ] **Step 1: Failing tests for `validateFeeBps`:**
  - 50 with cap 100 → null.
  - 101 with cap 100 → message containing "cap".
  - −1 and NaN → error.
  - 0 → null (free promos allowed).
  - Non-integer 12.5 → error ("whole basis points").
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): admin fee setting with audit`.

### Task 4: Quote math and breakdown

**Files:**
- Create: `src/lib/bridge/quote-math.ts`
- Test: `src/lib/bridge/quote-math.test.ts`

**Interfaces:**
- Produces:
  - `type Speed = "fast" | "standard"`
  - `computeBreakdown(input: { source: BridgeChainKey; dest: BridgeChainKey; amount: string; speed: Speed; feeBps: number; fastFeeBps: number; networkFeeAtomic: bigint }): Breakdown | { error: string }`
  - `Breakdown = { sendAtomic: bigint; settuFeeAtomic: bigint; fastFeeMaxAtomic: bigint; networkFeeAtomic: bigint; totalFeeAtomic: bigint; burnAtomic: bigint; receiveAtomic: bigint; receiveIsMinimum: boolean; adjustedAmount?: string }`
- All `*Atomic` values are in the **6-decimal CCTP unit**. Source amounts on Stellar are converted ×10.
- `burnAtomic = sendAtomic − settuFee − networkFee`.
- `fastFeeMaxAtomic = computeAtomicFee(fastFeeBps, burnAtomic)` (from `iris-client.ts`) when Fast, otherwise 0.
- `receiveAtomic = burnAtomic − fastFeeMaxAtomic`.
- `totalFeeAtomic = settuFee + networkFee`, which is what the contract takes.
- Round the Settu fee **up**, so Settu is never short and the user is never shown less than they receive.

- [ ] **Step 1: Failing tests:**
  - 100 USDC, fast, 50 bps, fastFee 1.3 bps, network 630000 → settu 500000, burn 98870000, fastMax ≥ 12853, receive = burn − fastMax, `receiveIsMinimum` true.
  - The same on standard → fastMax 0, `receiveIsMinimum` false.
  - **Review focus 2:** source stellar, amount `"10.1234567"` → `adjustedAmount === "10.123456"`, and the math is done on the adjusted value.
  - Fees ≥ amount → `{ error }` containing "too small".
  - `feeBps` 0 → settu 0.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): quote breakdown math`.

### Task 5: Quote encoding and signing (plus golden vectors)

**Files:**
- Create: `src/lib/bridge/quote.ts`
- Create: `contracts/test-vectors/quotes.json`, generated by a test helper and committed. Tasks 6–8 read it to prove the contracts verify what the server signs.
- Test: `src/lib/bridge/quote.test.ts`

**Interfaces:**
- Produces: `interface BridgeQuote { version: 1; sourceDomain: number; destDomain: number; user: string; amount: bigint; settuFee: bigint; networkFee: bigint; nativeFee: bigint; mintRecipient: `0x${string}`; hookData: `0x${string}`; maxFee: bigint; minFinality: 1000 | 2000; deadline: number; nonce: `0x${string}` }`.
  - `settuFee` is USDC, net of `maxFee` on Fast.
  - `networkFee` is USDC, non-zero only in USDC mode.
  - `nativeFee` is in the source chain's native units (wei, stroops or lamports), non-zero only in native mode.
  - EIP-712 type, exactly: `Quote(uint8 version,uint32 sourceDomain,uint32 destDomain,address user,uint256 amount,uint256 settuFee,uint256 networkFee,uint256 nativeFee,bytes32 mintRecipient,bytes hookData,uint256 maxFee,uint32 minFinality,uint64 deadline,bytes32 nonce)` (Ruling E, amended).
  - `mintRecipient` is bytes32: for Stellar destinations it's the forwarder, and for Solana it's the recipient's USDC ATA.
  - `hookData` is `0x` unless the destination is Stellar, where it's `buildForwarderHookData(user G)`.
  - `deadline` is in unix seconds. `nonce` is 32 random bytes.
- `user` is the source-chain address in that family's native form:
  - **EVM:** EIP-712 domain `{ name: "SettuBridge", version: "1", chainId, verifyingContract }`, with type `Quote` holding the fields above (`user` as `address`, `bytes32` for the hashes, `bytes` for `hookData`). `signEvmQuote(quote, chainId, verifyingContract, privateKey): Promise<Hex>` and `recoverEvmQuoteSigner(...)`.
  - **Stellar and Solana:** `encodeQuoteBytes(quote, family: "stellar" | "solana", contractId: string): Uint8Array`. This is a fixed big-endian layout: `"SETTU_BRIDGE_V1"` ‖ contractId bytes (32) ‖ srcDomain u32 ‖ destDomain u32 ‖ user (32 bytes: Stellar ed25519 public key, Solana pubkey) ‖ amount u64 ‖ settuFee u64 ‖ networkFee u64 ‖ nativeFee u64 ‖ mintRecipient 32 ‖ maxFee u64 ‖ minFinality u32 ‖ deadline u64 ‖ nonce 32 ‖ hookData length u32 ‖ hookData. `signEd25519Quote(bytes, secret): Uint8Array(64)` and `verifyEd25519Quote(bytes, sig, pubkey): boolean`.
- Keys come from env `BRIDGE_QUOTE_SIGNER_EVM_KEY` (hex) and `BRIDGE_QUOTE_SIGNER_ED25519_SECRET`. These are new keys, distinct from the relayer and the owner.

- [ ] **Step 1: Failing tests:**
  - **EVM:** a round trip recovers the signer address. Changing any single field changes the recovered address.
  - **ed25519:** a round trip verifies. Flipping any byte of the encoding fails verification. The encoding length is the expected fixed length plus `hookData`.
  - **Golden vectors:** a test helper writes `contracts/test-vectors/quotes.json` with three cases (EVM, Stellar, Solana), each holding quote fields, encoded bytes or digest, signature and signer. A test asserts the file matches what's generated now, so the file can't drift silently.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (viem `signTypedData` / `recoverTypedDataAddress`; Node `crypto` ed25519 or `tweetnacl`). **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): quote encoding, signing, golden vectors`.

### Task 4a: Fee by speed and the network-fee choice (amends Tasks 3 and 4)

This was added after the team review on 2026-11-17. Tasks 3 and 4 were already built, so this task changes their code.

**Files:**
- Modify: `src/lib/bridge/fee-settings.ts`, `src/lib/bridge/fee-settings.test.ts`
- Modify: `src/lib/bridge/quote-math.ts`, `src/lib/bridge/quote-math.test.ts`

**Interfaces:**
- **Fee settings:**
  - `DEFAULT_BRIDGE_FEE_BPS = { standard: 30, fast: 60 } as const` replaces the single 50.
  - `getBridgeFeeBps(speed: Speed): Promise<number>` reads Redis key `bridge:fee-bps:<speed>`. It falls back to the default **when the stored value isn't an integer in [0, 10000]** (this fixes the Task 3 deferred minor).
  - `setBridgeFeeBps(speed: Speed, bps, actor, lowestCapBps)`. Audit entries gain `speed`.
  - `validateFeeBps` also rejects a non-finite or negative `lowestCapBps`.
- **`computeBreakdown` input:** `{ source; dest; amount; speed; feeBps; fastFeeBps; networkFeeMode: "usdc" | "native"; networkFeeAtomic: bigint /* USDC, used in usdc mode */; nativeFeeAtomic: bigint /* source native units, used in native mode */ }`.
- **`Breakdown`:** `{ sendAtomic; settuFeeShownAtomic; settuFeeAtomic; fastFeeMaxAtomic; networkFeeAtomic; nativeFeeAtomic; burnAtomic; receiveAtomic; receiveIsMinimum; adjustedAmount? }`, computed as:
  - `settuFeeShownAtomic` = ceil(`sendAtomic × feeBps / 10000`). This is the "Settu fee (0.3%/0.6%)" line.
  - `fastFeeMaxAtomic` = `computeAtomicFee(fastFeeBps, sendAtomic)` on Fast, else 0. It's computed on `sendAtomic`, an upper bound on the burned amount, so `maxFee` is never below Circle's minimum.
  - `settuFeeAtomic` = `settuFeeShownAtomic − fastFeeMaxAtomic`. This is what the contract sends to Settu.
  - `networkFeeAtomic` is the input in usdc mode and 0 in native mode. `nativeFeeAtomic` is the input in native mode and 0 in usdc mode.
  - `burnAtomic` = `send − settuFee − networkFee`.
  - `receiveAtomic` = `send − settuFeeShown − networkFee`, which equals `burn − fastFeeMax`.
- **Errors:**
  - `{ error, code: "fast_unavailable" }` when `fastFeeMaxAtomic > settuFeeShownAtomic`
  - "too small" when `receiveAtomic ≤ 0`
  - reject a negative `networkFeeAtomic` or `nativeFeeAtomic` (fixes the Task 4 deferred minor)
  - set `adjustedAmount` only when the dropped Stellar digit is non-zero (fixes the Task 4 deferred minor)

- [ ] **Step 1: Failing tests:**
  - Standard, 100 USDC, 30 bps, usdc mode, network 630000 → shown 300000, settu 300000, fastMax 0, burn 99_070_000, receive 99_070_000, `receiveIsMinimum` false.
  - Fast, 100 USDC, 60 bps, fastFee 1.3 bps, usdc mode, network 630000 → shown 600000, fastMax 13000 (`computeAtomicFee(1.3, 100_000_000)`), settu 587000, burn 98_783_000, receive 98_770_000, `receiveIsMinimum` true.
  - Native mode, same Fast inputs with `nativeFeeAtomic` 210000000000000 → networkFee 0, nativeFee passed through, receive 99_400_000.
  - `fastFeeBps` so large that fastMax > shown → `code === "fast_unavailable"`.
  - Stellar `"10.1234560"` → no `adjustedAmount`. `"10.1234567"` → `adjustedAmount` `"10.123456"`.
  - A stored fee of `"abc"` → `getBridgeFeeBps` returns the default (inject the reader for the test).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS (full suite).
- [ ] **Step 5:** Commit: `feat(bridge): fee by speed and network-fee choice`.

---

## Phase 2: Contracts (testnets)

Each contract implements the same logic (spec §5). The function is `bridge(quote, signature, …)`, which does:
1. Check not paused.
2. Check `now ≤ deadline`.
3. Check the nonce is unused, then mark it used.
4. Check the quote's `user` equals the caller/authoriser, and its `amount` and `sourceDomain` equal this chain's.
5. Check the three limits:
   - `settuFee * 10_000 ≤ maxFeeBps * amount`
   - `networkFee ≤ maxNetworkFee`
   - `nativeFee ≤ maxNativeFee`
6. Verify the signature against `signer`.
7. Move `settuFee + networkFee` USDC from the user to `feeWallet`. If `nativeFee > 0`, also move exactly `nativeFee` of the native token from the user to `feeWallet`:
   - **EVM:** `msg.value == nativeFee` is required (and `msg.value == 0` when it's zero). Forward the value with a checked call.
   - **Stellar:** transfer through the native XLM Stellar Asset Contract.
   - **Solana:** a system-program transfer.
8. Burn `amount − settuFee − networkFee` through CCTP with the quote's destination, recipient, `maxFee`, finality and `hookData` (`WithHook` when `hookData` is non-empty).
9. Emit `Bridged(nonce, user, amount, settuFee, networkFee, nativeFee, destDomain, mintRecipient, minFinality)`.

**Owner-only:** `setSigner`, `setFeeWallet`, `setMaxFeeBps`, `setMaxNetworkFee`, `setMaxNativeFee`, `pause`, `unpause`, `transferOwnership`. Initial values: `maxFeeBps` = 100. `maxNetworkFee` and `maxNativeFee` are constructor/initialize arguments, chosen at deploy for each chain.

**Every contract's tests must include:**
- correct fee and burn amounts, with a zero contract balance after, in both USDC mode and native mode (the native amount reaches `feeWallet` exactly)
- a native amount that doesn't match `nativeFee` → revert
- `networkFee` over `maxNetworkFee` → revert
- `nativeFee` over `maxNativeFee` → revert
- expired quote → revert
- reused nonce → revert
- fee over the cap → revert
- wrong user, amount or domain → revert
- tampered signature → revert
- paused → revert
- each setter rejects a non-owner
- the golden vector from Task 5 verifies

### Task 6: EVM `SettuBridge.sol`

**Files:**
- Create: `contracts/evm/` (Foundry: `foundry.toml`, `src/SettuBridge.sol`, `test/SettuBridge.t.sol`, `test/mocks/MockTokenMessengerV2.sol`, `script/Deploy.s.sol`)
- Create: `contracts/evm/README.md`, covering build, test and deploy commands and the env vars they need

**Interfaces:**
- Consumes: the EIP-712 schema and golden vector from Task 5.
- Produces: `function bridge(Quote calldata q, bytes calldata sig, Permit calldata p) external`, where `struct Permit { uint256 value; uint256 deadline; uint8 v; bytes32 r; bytes32 s; bool use; }`. When `use` is true, call `IERC20Permit.permit` first. A permit that fails because the allowance already exists must not revert (try/catch).
- `function bridge(...) external payable`.
- `event Bridged(bytes32 indexed nonce, address indexed user, uint256 amount, uint256 settuFee, uint256 networkFee, uint256 nativeFee, uint32 destDomain, bytes32 mintRecipient, uint32 minFinality)`.
- Constructor: `(address usdc, address tokenMessenger, uint32 localDomain, address signer, address feeWallet, address owner, uint256 maxNetworkFee, uint256 maxNativeFee)`.
- OpenZeppelin `EIP712`, `SafeERC20`, `ReentrancyGuard`, `Ownable2Step`, `Pausable`. No proxy.

- [ ] **Step 1:** Write the Foundry tests listed above, using a mock TokenMessengerV2 that records its `depositForBurn` / `depositForBurnWithHook` arguments.
- [ ] **Step 2:** `cd contracts/evm && forge test` → FAIL.
- [ ] **Step 3:** Implement the contract.
- [ ] **Step 4:** `forge test` → all pass. `forge coverage` shows every branch of `bridge` covered.
- [ ] **Step 5:** Commit: `feat(bridge): EVM SettuBridge contract`.

### Task 7: Stellar Soroban `settu-bridge`

**Files:**
- Create: `contracts/stellar/settu-bridge/` (`Cargo.toml`, `src/lib.rs`, `src/test.rs`, `README.md`)

**Interfaces:**
- Produces:
  - `fn bridge(env, user: Address, quote: QuoteArgs, signature: BytesN<64>)`. `user.require_auth()` must cover the nested USDC transfer and Circle's `deposit_for_burn` / `deposit_for_burn_with_hook` on `stellarTokenMessengerMinter`.
  - `__constructor(admin, usdc, token_messenger, local_domain, signer: BytesN<32>, fee_wallet)`.
  - Events: topic `("bridged", nonce)`, data `(user, amount, settu_fee, network_fee, native_fee, dest_domain, mint_recipient, min_finality)`.
  - The constructor also takes `native_token` (the native XLM SAC address), `max_network_fee` and `max_native_fee`.
- The quote message is `encodeQuoteBytes(…, "stellar", <this contract id>)` from Task 5. Verify it with `env.crypto().ed25519_verify`.
- Read the existing allowance flow in `src/lib/cctp/stellar-cctp.ts` (`checkStellarUsdcAllowance` / `buildApproveUsdcTx`). With nested auth, Circle's messenger pulls from `user` directly. Confirm this in a test with a mock messenger that calls `token.transfer_from` or `burn` the same way the real one does. Read Circle's Stellar CCTP contract source or interface to match it exactly.

- [ ] **Step 1:** Write the Soroban tests listed above (`soroban_sdk::testutils`, a mock messenger contract, the golden vector).
- [ ] **Step 2:** `cargo test` → FAIL.
- [ ] **Step 3:** Implement the contract.
- [ ] **Step 4:** `cargo test` → PASS. `stellar contract build` produces wasm.
- [ ] **Step 5:** Commit: `feat(bridge): Stellar Soroban settu-bridge contract`.

### Task 8: Solana Anchor `settu_bridge`

**Files:**
- Create: `contracts/solana/settu_bridge/` (Anchor workspace: `programs/settu_bridge/src/lib.rs`, `tests/settu_bridge.ts`, `README.md`)

**Interfaces:**
- Produces: instruction `bridge(quote: QuoteArgs)`. It verifies that the **immediately preceding instruction** is an Ed25519SigVerify instruction over `encodeQuoteBytes(…, "solana", program_id)` with the stored signer pubkey (read through the instructions sysvar). Then it does an SPL transfer of `total_fee` from the user's USDC ATA to the fee wallet's ATA, and a CPI to Circle's TokenMessengerMinterV2 `deposit_for_burn` / `deposit_for_burn_with_hook` with the user as signer.
- Accounts mirror `buildSolanaDepositForBurnInstruction` in `src/lib/solana/deposit-for-burn.ts` (vendored IDL `src/lib/solana/idl/token_messenger_minter_v2.json`), plus `config` (PDA), `nonce_record` (PDA seeded by the nonce, `init`: a reused nonce fails), and `fee_token_account`.
- Instructions: `initialize(signer, fee_wallet, max_fee_bps, max_network_fee, max_native_fee)`, `set_signer`, `set_fee_wallet`, `set_max_fee_bps`, `set_max_network_fee`, `set_max_native_fee`, `set_paused`. A `native_fee` in lamports moves user → fee wallet through a system-program CPI.
- Event `Bridged`.

- [ ] **Step 1:** Write Anchor tests (bankrun or a local validator with a Circle program mock, or the cloned devnet programs) for the list above. Include: a missing ed25519 instruction → error, an ed25519 instruction for different bytes → error.
- [ ] **Step 2:** `anchor test` → FAIL.
- [ ] **Step 3:** Implement the program.
- [ ] **Step 4:** `anchor test` → PASS.
- [ ] **Step 5:** Commit: `feat(bridge): Solana settu_bridge program`.

### Task 9: Testnet deployment and contract config

**Files:**
- Create: `src/lib/bridge/contracts.ts`
- Create: `scripts/bridge/deploy-testnets.md` (exact commands run, deployed addresses, tx links)
- Modify: `src/lib/bridge/address.ts` (fill in `BRIDGE_FORBIDDEN_ADDRESSES` with the deployed contracts and relayers)
- Test: `src/lib/bridge/contracts.test.ts`

**Interfaces:**
- Produces: `bridgeContractFor(chain: BridgeChainKey): string`, read from env `BRIDGE_CONTRACT_<CHAIN>` (e.g. `BRIDGE_CONTRACT_BASE`). It throws a clear error if unset. Also `FEE_WALLET_<CHAIN>` env.

- [ ] **Step 1:** Deploy all 8 contracts to testnets (Sepolia, Base Sepolia, Arbitrum Sepolia, OP Sepolia, Fuji, Amoy, Stellar testnet, Solana devnet). Use owner, signer, fee wallet and relayer keys generated for testnet, and record them in a gitignored `.env.bridge-testnet` file. Record the addresses in `deploy-testnets.md`.
- [ ] **Step 2:** Failing test: `bridgeContractFor` throws when unset and returns the env value when set.
- [ ] **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `chore(bridge): testnet deployments and contract config`.

---

## Phase 3: Server

### Task 10: Destination network fee estimate

**Files:**
- Create: `src/lib/bridge/network-fee.ts`
- Test: `src/lib/bridge/network-fee.test.ts`

**Interfaces:**
- Produces: `estimateNetworkFee(dest: BridgeChainKey, source: BridgeChainKey, opts: { needsSolanaAta: boolean }, deps?: NetworkFeeDeps): Promise<{ usdcAtomic: bigint /* 6-dec */; nativeAtomic: bigint /* SOURCE chain native units */ }>`, where `NetworkFeeDeps = { gasCostNative(dest): Promise<bigint /* wei | lamports | stroops */>; nativeUsdPrice(chain: BridgeChainKey): Promise<number> }`.
  - `usdcAtomic` is the destination gas cost in USD, with the margin applied, in 6-decimal USDC.
  - `nativeAtomic` is that same USD value converted into the source chain's native token: wei for EVM (18 decimals), stroops for Stellar (7), lamports for Solana (9), rounded up.
  - The defaults use the chain RPCs and the chosen price source.
- Per-family gas units come from measured testnet mints (Task 14): EVM `receiveMessage`, Stellar `mint_and_forward`, Solana `receive_message`, plus ATA rent (2,039,280 lamports) when `needsSolanaAta`.
- Margin: `NETWORK_FEE_MARGIN = 1.25` (builder's call per spec §12; documented in code).
- **Fails closed:** a missing or zero price, or an RPC error → throw `NetworkFeeUnavailableError`.

- [ ] **Step 1: Failing tests with injected deps:**
  - EVM dest: 0.0001 ETH at $3,000 → `usdcAtomic` 375000 (0.30 × 1.25). With source solana at $150 → `nativeAtomic` 2500000 lamports (0.375 / 150 = 0.0025 SOL).
  - Solana with ATA: rent is included.
  - Price 0 → throws `NetworkFeeUnavailableError`.
  - Price rejects → throws.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): destination network fee in USDC`.

### Task 11: Quote endpoint and live address checks

**Files:**
- Create: `src/lib/bridge/address-live.ts` (Stellar account + USDC trustline; Solana USDC ATA derivation and existence; a token-account-pasted check)
- Create: `src/lib/bridge/build-quote.ts`
- Create: `src/app/api/bridge/quote/route.ts`
- Test: `src/lib/bridge/address-live.test.ts`, `src/lib/bridge/build-quote.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5, 9, 10.
- The request also carries `networkFeeMode: "usdc" | "native"`.
  - In native mode, check the user's source native balance covers `nativeFee` plus an estimate of their own source-gas. If it doesn't, return `{ error, code: "insufficient_native" }`, and the UI shows "Not enough {native}".
  - The speed's fee comes from `getBridgeFeeBps(speed)` (Task 4a).
  - A `fast_unavailable` breakdown → HTTP 409 with that code, so the UI can switch to Standard.
- Produces:
  - `checkDestinationLive(chain, address, deps?): Promise<{ ok: true; solanaAta?: string; needsSolanaAta?: boolean } | { ok: false; code: "no_account" | "no_trustline" | "token_account"; message: string }>`
  - `buildQuote(req: QuoteRequest, deps?): Promise<QuoteResponse>`, where `QuoteRequest = { source; dest; amount: string; speed: Speed; user: string; recipient: string }` and `QuoteResponse = { quote: BridgeQuote (bigint→string serialised); signature: string; breakdown: Breakdown (serialised); expiresAt: number; contract: string } | { error: string; code: string }`
  - `POST /api/bridge/quote` → `buildQuote` (400 on validation errors, 503 with the no-quote copy on `NetworkFeeUnavailableError` or an Iris failure)
- The signed `deadline` is `now + 120`. The Fast fee bps comes from `getBurnFeeQuote({ sourceDomain, destDomain })`.

- [ ] **Step 1: Failing tests:**
  - Stellar recipient without a trustline → `no_trustline`.
  - Solana recipient without an ATA → ok, with `needsSolanaAta` true.
  - **Review focus 3:** a pasted Solana address that is itself a USDC token account → `token_account`, message `"That's a USDC token account. Paste the wallet address instead."`.
  - `buildQuote` refuses to sign when `validateDestinationAddress` fails.
  - The signature verifies with Task 5's recover/verify.
  - `deadline − now === 120`.
  - Same-chain source and dest → error.
  - The fee setting is read from `getBridgeFeeBps`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): signed quote endpoint`.

### Task 12: Source transaction builders

**Files:**
- Create: `src/lib/bridge/build-source-tx.ts`
- Create: `src/app/api/bridge/build-tx/route.ts`
- Test: `src/lib/bridge/build-source-tx.test.ts`

**Interfaces:**
- Consumes: `QuoteResponse` (Task 11) and `bridgeContractFor` (Task 9).
- Produces: `buildSourceTx(q: QuoteResponse, userAddress: string, opts: { permit?: PermitSig }): Promise<SourceTx>`:
  - **EVM:** `{ family: "evm"; chainId; to; data; value: string /* wei, = nativeFee */; needsApproval: boolean }`. `needsApproval` is true when the allowance is below the amount and there's no permit.
  - **Stellar:** `{ family: "stellar"; xdr }`, an unsigned, simulated, assembled invoke of `bridge`.
  - **Solana:** `{ family: "solana"; txBase64 }`, an unsigned v0 tx of [Ed25519 verify ix, `bridge` ix] plus the MessageSent event keypair partially signed by the server, as `solana-build-tx` does today.
- Also produces `permitTypedData(chain, owner, amount, deadline)`, for the client to sign an EIP-2612 permit (USDC `name`/`version` read on-chain).

- [ ] **Step 1: Failing tests:**
  - EVM calldata decodes, through the contract ABI, back to the same quote and signature, and `value` equals `nativeFee` (0 in usdc mode).
  - The Stellar XDR contains one `invokeHostFunction` calling `bridge` on the bridge contract.
  - The Solana tx's first instruction is the Ed25519 program with exactly the `encodeQuoteBytes` message.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): source transaction builders`.

### Task 13: Bridge records, registration and status

**Files:**
- Modify: `src/lib/cctp/cctp-store.ts` (add `"bridge"` to `direction`, plus optional `bridge?: BridgeMeta`)
- Create: `src/lib/bridge/bridge-store.ts`
- Create: `src/app/api/bridge/register/route.ts`
- Create: `src/app/api/bridge/[id]/route.ts`
- Create: `src/lib/bridge/read-source-event.ts`
- Test: `src/lib/bridge/bridge-store.test.ts`, `src/lib/bridge/read-source-event.test.ts`

**Interfaces:**
- Produces:
  - `BridgeMeta = { source; dest; user; recipient; speed; quoteNonce; sendAtomic; settuFeeAtomic; networkFeeAtomic; fastFeeMaxAtomic; receiveMinAtomic; receivedAtomic?; attestedAt?; fellBackToStandard?: boolean }`
  - `readBridgedEvent(chain, txHash): Promise<BridgedEvent | null>`: reads the `Bridged` event of our contract in that tx; null if absent or not ours
  - `registerBridge(chain, txHash): Promise<CctpTransferRecord>`: idempotent; the record id is `txHash`; values are taken from the **on-chain event**, not the client
  - `getBridgeStatus(id): Promise<BridgeStatusView>`
  - `type BridgeStatusView = { id; status: "submitted" | "verifying" | "delivering" | "completed" | "failed"; source; dest; recipient; sendAtomic; receiveMinAtomic; receivedAtomic?; sourceTx; destTx?; canSelfClaim: boolean; fellBackToStandard: boolean }`. The view maps CCTP statuses: burned/attesting → verifying; attested/minting → delivering.
  - `POST /api/bridge/register {chain, txHash}` → the view
  - `GET /api/bridge/[id]` → the view, with `Cache-Control: no-store`
- `canSelfClaim` = attested, not completed, and `now − attestedAt ≥ 30 min`.
- `registerBridge(chain, txHash, onRegistered: (id: string) => Promise<void> = async () => {})`. Task 15 passes `scheduleDrive` as `onRegistered` from the register route. Keep this task free of QStash.

- [ ] **Step 1: Failing tests:**
  - Registering the same tx twice → one record.
  - Registering a tx without our event → 400.
  - Amounts come from the event, even when the client sends different ones.
  - Each status maps to the right view.
  - `canSelfClaim` is false at 29 min and true at 30 min.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): bridge records, registration, status`.

### Task 14: Destination minting on all three families

**Files:**
- Modify: `src/lib/cctp/base-cctp.ts`. Generalise to `submitEvmMint(chain: EvmChainKey, params: { messageHex; attestationHex }): Promise<string | null>`, using the same `sendWithFeeBump`, `isMessageAlreadyMinted` and gas floor per chain. `submitBaseMint` becomes a wrapper so the offramp is unchanged.
- Create: `src/lib/bridge/mint/solana.ts`: `submitSolanaMint(params & { recipientAta: string; createAta: boolean }): Promise<string | null>`. This is `receive_message` on MessageTransmitterV2 with TokenMessengerMinterV2 remaining accounts, plus ATA creation in the same tx. It returns null if the message is already received (UsedNonce PDA exists).
- Reuse: `submitMintAndForward` (Stellar).
- Modify: `src/lib/cctp/advance.ts`. For `direction === "bridge"`, dispatch the mint by `bridgeChainByDomain(destDomain).family`. A `null` mint hash means already minted, so mark it completed (same as PR #80).
- Create: `src/lib/bridge/received-amount.ts`: `readReceivedAtomic(dest, mintTx): Promise<bigint>`, the actual minted amount, stored in `BridgeMeta.receivedAtomic`.
- Test: `src/lib/cctp/advance.test.ts` (new) and `src/lib/bridge/mint/solana.test.ts`

**Interfaces:**
- Gas-floor errors (`CctpBaseGasError` and per-chain equivalents) **must not count toward `MAX_ATTEMPTS`**. The transfer stays `attested`, `lastError` is set, and `reportGasBalance` fires.
- When a bridge's attestation arrives, set `BridgeMeta.attestedAt`. If the quote was Fast but Iris reports `finalityThresholdExecuted === 2000`, set `fellBackToStandard: true`.
- When a bridge transitions to `failed`, send `notify(…, "critical")` (from `src/lib/notify/telegram.ts`) with the id, route and last error.

- [ ] **Step 1: Failing tests:**
  - A bridge to Arbitrum calls `submitEvmMint("arbitrum", …)`, one to Stellar calls `submitMintAndForward`, and one to Solana calls `submitSolanaMint` with the ATA from `BridgeMeta`.
  - A null result → completed.
  - **Review focus 5:** 25 consecutive gas-floor errors leave the status `attested`, not `failed`, with `attempts` unchanged, and an alert is reported.
  - Offramp transfers still call `submitBaseMint`.
  - A Fast quote attested at 2000 → `fellBackToStandard` true.
  - Transition to `failed` → one critical notify.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Record the measured gas units from one real testnet mint per family in `network-fee.ts` (Task 10's constants).
- [ ] **Step 6:** Commit: `feat(bridge): mint on every destination family`.

### Task 15: Server-side driving and the event sweep

**Files:**
- Create: `src/lib/bridge/schedule.ts`: `scheduleDrive(id: string, attempt = 0): Promise<void>`. It publishes a QStash message to `/api/bridge/drive/[id]` with delay `[15, 30, 60, 120, 300][attempt]` seconds. Past the last delay it stops, and the 5-minute sweep takes over.
- Create: `src/app/api/bridge/drive/[id]/route.ts`. It verifies the QStash signature, calls `advanceCctpTransfer(id)`, and if the transfer isn't final, calls `scheduleDrive(id, attempt + 1)`.
- Create: `src/lib/bridge/event-sweep.ts`: `sweepBridgedEvents(deps?): Promise<{ created: number; advanced: number }>`. For each chain it reads our contract's `Bridged` events since the last cursor (Redis `bridge:sweep-cursor:<chain>`). EVM uses `eth_getLogs` on the contract address in chunks of ≤ 2,000 blocks through publicnode-style RPCs. Stellar uses `getEvents`. Solana uses `getSignaturesForAddress` on the program. It registers unknown ones (Task 13), then advances every non-final bridge in `cctp:pending-transfers`.
- Modify: `src/app/api/admin/offramp/sweep-burns/route.ts`. Also call `sweepBridgedEvents()` (same QStash schedule, every 5 min).
- Modify: `src/app/api/bridge/register/route.ts`. Pass `scheduleDrive` as `onRegistered` (Task 13).
- Test: `src/lib/bridge/schedule.test.ts`, `src/lib/bridge/event-sweep.test.ts`

**Interfaces:**
- Env: `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `APP_BASE_URL`.

- [ ] **Step 1: Failing tests:**
  - The delays for attempts 0–4 are as listed, and attempt 5 publishes nothing.
  - The drive route rejects an unsigned request (401).
  - A final transfer isn't rescheduled.
  - **Review focus 4:** a `Bridged` event with no Redis record → the sweep creates it and advances it, and running the sweep twice creates it once.
  - The cursor advances only after a chain's events are processed.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `@upstash/qstash` (pin an exact version at least 2 weeks old). **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): server-driven completion and event sweep`.

### Task 16: Relayer gas alerts on all 8 chains

**Files:**
- Bring in `src/lib/notify/gas-alert.ts` from `feat/hot-wallet-gas-alert` (`git cherry-pick -x 36ef538`).
- Modify: the per-chain gas-floor checks from Task 14, to call `reportGasBalance` with wallet names "Base relayer", "Arbitrum relayer", and so on, plus "Solana relayer" and "Stellar relayer". Warn and floor levels come from env `BRIDGE_GAS_WARN_<CHAIN>` / `BRIDGE_GAS_FLOOR_<CHAIN>`, with defaults per chain set in code.
- Test: extend `src/lib/notify/gas-alert.test.ts` for a Solana reading (unit `SOL`).

- [ ] **Steps:** cherry-pick → failing test for `unit: "SOL"` → widen the `unit` type to `"ETH" | "XLM" | "SOL" | "AVAX" | "POL"` → PASS → commit `feat(bridge): relayer gas alerts on every chain`.

---

## Phase 4: Admin

### Task 17: Admin console (fee, cap, bridges, relayers)

**Files:**
- Create routes, all guarded by `isAuthorisedAdmin(request)` from `src/lib/admin/auth.ts`:
  - `src/app/api/admin/bridge/fee/route.ts`: GET returns `{ standardBps, fastBps, audit, lowestCapBps }`; PUT `{ speed, feeBps }` calls `setBridgeFeeBps`
  - `src/app/api/admin/bridge/caps/route.ts`: GET reads `maxFeeBps`, `maxNetworkFee` and `maxNativeFee` from all 8 contracts
  - `src/app/api/admin/bridge/list/route.ts`: recent bridges with their status views
  - `src/app/api/admin/bridge/revive/route.ts`: wraps `reviveStuckTransfer`, then `scheduleDrive`
  - `src/app/api/admin/bridge/relayers/route.ts`: native balances for the 8 relayers
- Create: `src/components/admin/BridgeAdminPanel.tsx`, mounted in `src/components/admin/AdminRecoveryConsole.tsx` as a "Bridge" section.
- Create: `src/lib/bridge/owner-txs.ts`: `buildSetLimitTx(chain, limit: "maxFeeBps" | "maxNetworkFee" | "maxNativeFee", value: bigint, ownerAddress): SourceTx-like`. It's unsigned, for the **owner wallet connected in the browser**, never a server key.
- Test: `src/lib/bridge/owner-txs.test.ts`, plus route tests for the auth guard

**Interfaces:**
- **Cap panel flow (spec §5):**
  1. Show the current cap per chain.
  2. Take one new value.
  3. For each family, connect the owner wallet (reuse the app's wallet hooks) and sign `setMaxFeeBps` on each of its chains in sequence.
  4. Re-read all 8 caps and highlight any chain whose value differs.
- **Cap rules:** refuse a new cap below the current fee (message: "Lower the bridge fee first"). PUT fee refuses a value above the lowest cap.

- [ ] **Step 1: Failing tests:**
  - Each route without admin auth → 401.
  - PUT fee 150 with lowest cap 100 → 400.
  - `buildSetLimitTx("base", "maxFeeBps", 80n, owner)` encodes `setMaxFeeBps(80)` to the Base contract, and `"maxNativeFee"` encodes `setMaxNativeFee`.
  - A cap lower than the fee is refused.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Check the panel manually against the existing console's style.
- [ ] **Step 5:** Commit: `feat(bridge): admin fee, cap, bridges and relayers`.

---

### Task 17a: Admin bridge explorer (live)

This was added at the owner's request on 2026-11-17: an admin-only page that shows every bridge transaction live, like an indexer.

**Files:**
- Modify: `src/lib/bridge/bridge-store.ts`. On create, also `ZADD bridge:index <createdAt> <id>`.
- Create: `src/lib/bridge/explorer.ts`:
  - `listBridges({ cursor?, limit = 50, status?, source?, dest?, speed?, from?, to?, q? }): Promise<{ rows: ExplorerRow[]; nextCursor?: string }>` reads the index newest-first and MGETs the records. `q` matches the tx hash, user, or recipient (exact or prefix).
  - `bridgeTotals(window: "24h" | "7d"): Promise<{ count; volumeAtomic; feesAtomic; inProgress; failedOrStuck }>`.
- Create: `src/app/api/admin/bridge/explorer/route.ts` (GET, guarded by `isAuthorisedAdmin`, `Cache-Control: no-store`).
- Create: `src/app/admin/bridge/page.tsx`, `src/components/admin/BridgeExplorer.tsx`.
- Modify: `src/lib/bridge/event-sweep.ts` (Task 15). Swept bridges are indexed too.
- Test: `src/lib/bridge/explorer.test.ts`, plus an auth-guard test for the route.

**Interfaces:**
- `ExplorerRow = BridgeStatusView & { createdAt; speed; settuFeeAtomic; networkFeeAtomic; nativeFeeAtomic; attempts; lastError?; stuck: boolean }`.
  - `stuck` is true when the bridge isn't final and was last updated more than 30 minutes ago.
  - Addresses shown are the user's real source and destination addresses, not the bytes32 mint recipient.

**UI** (existing admin console style):
- **Summary strip:** 24h and 7d count, volume, fees, in progress, failed or stuck.
- **Table, newest first:** time, route, speed, sender → recipient (short, with copy), sent / received / fee, a status pill (Submitted, Verifying, Delivering, Completed, Failed, Stuck), source and dest tx explorer links, age.
- **Row detail:** full fee breakdown, timeline (burned, attested, minted), last error, attempts, and the existing Revive / Retry mint actions from Task 17.
- **Filters:** status, route, speed, date. **Search:** by tx hash or address.
- **Live:** poll the explorer endpoint every **10 s only while `document.visibilityState === "visible"`**. New rows animate in at the top. **No SSE.**

- [ ] **Step 1: Failing tests:**
  - The index is ordered newest-first.
  - Each filter narrows the results.
  - `q` finds a row by source tx hash and by recipient.
  - `stuck` flips at 30 minutes.
  - Totals sum only the window.
  - The route returns 401 without admin auth.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. Check the page manually in the dev server against the admin console style.
- [ ] **Step 5:** Commit: `feat(bridge): admin bridge explorer`.

---

## Phase 5: User interface

### Task 18: Bridge route and navigation

**Files:**
- Modify: `src/components/app/AppShell.tsx` (add `{ href: "/app/bridge", label: "Bridge", title: "Bridge", icon: BridgeIcon }` after Onramp)
- Modify: `src/components/app/icons.tsx` (add `BridgeIcon`: two opposing arrows, the same as the mockup's swap glyph)
- Create: `src/app/app/bridge/page.tsx`, rendering `<BridgePanel />`

- [ ] **Steps:** add the nav item, icon and page → `npx tsc --noEmit` clean → load `/app/bridge` in the dev server and check the sidebar highlight and the mobile drawer item → commit `feat(bridge): bridge route and nav`.

### Task 19: Bridge form

**Files:**
- Create: `src/components/bridge/BridgePanel.tsx` (state and orchestration)
- Create: `src/components/bridge/BridgeLegCard.tsx` (the From/To card)
- Create: `src/components/bridge/SpeedToggle.tsx` (also used for the network-fee switch, with two labelled options)
- Create: `src/components/bridge/BridgeReceiveCard.tsx`
- Create: `src/components/bridge/useBridgeQuote.ts`
- Create: `src/lib/bridge/form-state.ts` (pure reducer)
- Test: `src/lib/bridge/form-state.test.ts`

**Interfaces:**
- Consumes: `BRIDGE_CHAIN_OPTIONS`, `validateDestinationAddress`, `POST /api/bridge/quote`, and the existing wallet hooks (`useStellarWallet`, `useEvmWallet`, the Solana AppKit hook) chosen by `BRIDGE_CHAINS[key].family`.
- Produces:
  - `bridgeFormReducer(state, action)` with actions `setSource`, `setDest`, `swap`, `setAmount`, `setSpeed`, `setNetworkFeeMode`, `setPastedAddress`, `useConnectedDest`, `quoteLoaded`, `quoteFailed`, `confirmFirstTime`
  - `disableReason(state): string | null`: the button's reason text, e.g. "Enter an amount", "Connect your Solana wallet", "Check the destination address", "Confirm you've checked this address", "Getting your price…"
- First-time addresses are stored in `localStorage` key `settu:bridge-known:<userAddress>`, wrapped in try/catch. If storage is unavailable, treat the address as first-time.

- [ ] **Step 1: Failing reducer tests:**
  - `swap` swaps source and dest, the wallets and the pasted address.
  - `setDest` to the current source → swaps.
  - A pasted address that fails validation → `disableReason === "Check the destination address"`, with the validation message exposed.
  - A first-time valid address → reason "Confirm you've checked this address" until `confirmFirstTime`.
  - An amount change clears the quote. So does a network-fee-mode change.
  - A `quoteFailed` with code `insufficient_native` sets `disableReason` to "Not enough {native}" and keeps the mode selectable.
  - `fast_unavailable` switches speed to standard, with the notice "Fast isn't available for this route right now".
- [ ] **Step 2:** FAIL. **Step 3:** Implement the reducer, then build the components to the mockup, using `AppSelect`, `fieldBox`/`fieldLabel` classes, the glass pill, the `.seg`-style toggle (same classes as FormCard's USDC/NGN switch) and the receive card with Show/Hide fee. Fetch quotes debounced at 400 ms after input, and re-fetch 15 s before `expiresAt`. **Step 4:** PASS.
- [ ] **Step 5:** Check it on desktop and phone width (≤ 720 px) in the dev server. Commit: `feat(bridge): bridge form`.

### Task 20: Signing, progress, result, self-claim

**Files:**
- Create: `src/components/bridge/useBridgeFlow.ts`
- Create: `src/components/bridge/BridgeStatusPanel.tsx` (stepper copied from `OfframpStatusPanel` with the bridge steps)
- Create: `src/lib/bridge/poll-status.ts`
- Create: `src/lib/bridge/self-claim.ts`
- Modify: `src/lib/offramp/transaction-history.ts` (add `kind: "bridge"` entries with the breakdown and both tx links) and `src/components/app/HistoryList.tsx` to render them
- Test: `src/lib/bridge/poll-status.test.ts`, `src/lib/bridge/bridge-flow.test.ts`

**Interfaces:**
- Produces:
  - `pollBridgeStatus(id, onUpdate, deps?): () => void`. It fetches `GET /api/bridge/[id]` every 5 s only while visible, pauses on `visibilitychange` to hidden, resumes on visible, and stops at a final status or 20 min. It returns `stop`.
  - `useBridgeFlow()` runs these steps:
    1. Refresh the quote if fewer than 20 s are left.
    2. EVM only: permit or approve.
    3. Build the tx (Task 12).
    4. Wallet signs.
    5. Submit.
    6. Register (Task 13).
    7. Poll.
  - `selfClaim(view): Promise<string>`. It fetches the attestation, then the user's wallet on the destination submits the mint (EVM `receiveMessage`, Stellar `mint_and_forward`, Solana `receive_message`), and the user pays the gas.
- **Result copy:**
  - **Success:** `ResultCard` "Done! {received} USDC arrived", body "Sent to {short} on {chain}.", action "View transaction". A second, outlined action "Offramp to naira" goes to `/app/offramp?chain=<dest>`.
  - **Failure:** what failed, plus "No funds left your wallet" only when there's no source tx.
  - **Still on its way:** at 20 min, "Still on its way — we'll keep going in the background", with tx links.

- [ ] **Step 1: Failing tests:**
  - The poller makes no fetch while hidden, resumes on visible, stops on `completed`, and stops at 20 min.
  - **Review focus 1:** when the quote has expired at signing time, the flow fetches a new quote and returns `needsReconfirm` with the new breakdown, without calling the wallet.
  - A `fellBackToStandard` view shows "Taking the standard route — still on its way".
  - `canSelfClaim` shows a "Claim it yourself" action.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(bridge): signing flow, progress, result and self-claim`.

---

## Phase 6: End-to-end on testnets

### Task 21: Testnet verification

**Files:**
- Create: `scripts/bridge/e2e.ts`. It runs a bridge with server-held testnet user keys, then asserts `receivedAtomic ≥ receiveMinAtomic` and that the status reaches `completed`.
- Create: `docs/superpowers/plans/2026-11-16-user-bridge-e2e-results.md`, with one row per run: route, speed, sent, shown, received, source tx, dest tx, time.

- [ ] **Step 1:** Run on both Fast and Standard, and in both network-fee modes (USDC and native) for at least one route per family: EVM→EVM (Base Sepolia → Arbitrum Sepolia), EVM→Solana, Solana→EVM, EVM→Stellar, Stellar→EVM, Solana→Stellar, Stellar→Solana.
- [ ] **Step 2:** In the browser (preview deploy of the branch, with testnet env vars on Preview), run one bridge and close the tab right after signing. It must still complete (Task 15).
- [ ] **Step 3:** Perform one self-claim (temporarily disable the drive with an env flag `BRIDGE_DRIVE_DISABLED=1` on the preview).
- [ ] **Step 4:** For every run, delivered ≥ shown. Record the results.
- [ ] **Step 5:** Commit the results. Push `feat/user-bridge`. **Do not open a PR.**
