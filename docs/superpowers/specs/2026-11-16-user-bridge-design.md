# User Bridge: design

**Date:** 2026-11-16
**Branch:** `feat/user-bridge`. It is pushed to the remote and kept there. **No PR into `main` and no production deploy** until the owner says so, the same as the wallet work.
**Mockup:** [`assets/2026-11-16-user-bridge-mockup.html`](assets/2026-11-16-user-bridge-mockup.html). Open it in a browser. It was approved as "perfect", and it reuses the app's existing components.

---

## 1. Intent

A Settu user has USDC on one chain, for example in Phantom on Solana. They need it on another chain, usually so they can offramp it to naira. Today they'd leave Settu and use a third-party bridge. This feature lets them bridge USDC between any two of the 8 chains Settu supports, inside Settu, through Circle's CCTP.

It was pitched for a grant as covering all 8 chains in both directions: Stellar, Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon and Solana. That's 56 routes.

### What the owner said makes it a failure, even if it technically works

1. **The fees aren't laid out so any user can understand them.**
2. **The amount the user receives isn't what was displayed.**
3. **It has the problems the offramp has sometimes had:** stalled transfers, burns we lost track of, a relayer out of gas, stuck mints. It must be smooth and trouble-free, so we win users and keep them.

Every section below is checked against these three points.

---

## 2. Goals, non-goals, anti-goals

**Goals**
- Bridge USDC between any two of the 8 chains, with the user choosing **Fast or Standard**.
- **One wallet signature on the source chain** for the bridge itself, through a Settu bridge contract on each chain (§5). The fee is collected in the same transaction.
- **Settu pays the destination gas and claims the USDC for the user.** The user never needs gas on the destination chain. That cost is charged in USDC at quote time, on the source chain.
- **A full, plain breakdown in USDC** before they confirm, and the same breakdown afterwards.
- **The amount shown is guaranteed.** The user receives exactly that amount, or slightly more on Fast, and never less (§7).
- **Completion doesn't depend on the user's tab.** Every bridge is driven to delivery on the server (§9).
- **The platform fee is set in one place**, the admin console, and applies on all chains immediately (§6). It starts at **0.5%**.

**Non-goals for this branch**
- Mainnet launch. Contracts go to **testnets** and are exercised there. Mainnet deployment waits for a security audit (§12).
- Bridging anything other than USDC.
- Bridging into the offramp in a single flow. The success card links to the offramp; it doesn't chain the two.
- Settu holding user funds at any point. The contracts hold no balance between calls.

**Anti-goals**: a result that technically works but is wrong.
- A fee hidden as a percentage, or "included" without an amount.
- A delivered amount that's lower than the amount shown.
- Long-lived browser streams or polling loops that never stop. The offramp's bridge stream reconnected forever and used about 95% of Vercel CPU in November 2026 (PR #86).
- Funds that can only be claimed while Settu is up.

---

## 3. Constraints and facts the design rests on

- **A CCTP mint recipient is fixed at burn time and can't be redirected.** A wrong destination means the funds are lost for good. This happened with real user funds in September 2026. Address validation (§8) is safety-critical.
- **CCTP V2 is the protocol.** `depositForBurn(amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold)` takes `minFinalityThreshold` 1000 for Fast and 2000 for Standard (`FINALITY_THRESHOLD` in `src/lib/cctp/constants.ts`). There is also `depositForBurnWithHook` (hook data).
- **CCTP domains:**

  | Chain | Domain |
  |---|---|
  | Ethereum | 0 |
  | Avalanche | 1 |
  | Optimism | 2 |
  | Arbitrum | 3 |
  | Solana | 5 |
  | Base | 6 |
  | Polygon | 7 |
  | Stellar | 27 |

  `CCTP_DOMAIN` today only lists Stellar and Base. Copy addresses and domains from Circle's raw docs and cross-check them on each chain's explorer, the same standard `constants.ts` and `evm-chains.ts` were held to.
- **Circle charges a Fast fee** (live from Iris, `getBurnFeeQuote` in `iris-client.ts`). It's capped per transfer by `maxFee`, and Circle may charge less than the cap. Standard has no Circle fee.
- **Decimals:** USDC has 6 decimals on EVM and Solana, and 7 on Stellar. Amounts leaving Stellar must be multiples of 10 Stellar units, so nothing is lost converting 7→6. Reject or round down in the quote, and never silently.
- **How the mint recipient works per destination:**
  - **EVM:** the recipient's address.
  - **Solana:** the recipient's **USDC associated token account (ATA)**, not their wallet address.
  - **Stellar:** a G-address recipient goes through Circle's **CCTP Forwarder** (`stellarCctpForwarder`): the mint recipient is the forwarder, with the user's address as hook data. `buildForwarderHookData` and `submitMintAndForward` already do this for the onramp.
- **Stellar allows one contract call per transaction.** Fee and burn must happen inside one call, which is our contract (§5).
- **Hosting:** Vercel on the Hobby plan. Daily crons only, with a limited Active CPU budget. An Upstash QStash schedule already calls `/api/admin/offramp/sweep-burns` every 5 minutes, and `.github/workflows/sweep-burns.yml` is the manual fallback. Redis is Upstash.
- **Existing code to reuse rather than rewrite:**

  | File | What it already does |
  |---|---|
  | `src/lib/cctp/evm-burn.ts` | EVM burn calldata |
  | `src/lib/cctp/evm-chains.ts` | EVM chain table |
  | `src/lib/cctp/stellar-cctp.ts` | Stellar burn, approve and allowance, `submitMintAndForward` |
  | `src/lib/solana/deposit-for-burn.ts` | Solana burn, with the vendored Anchor IDL |
  | `src/lib/cctp/iris-client.ts` | Attestations, fee quotes, re-attest |
  | `src/lib/cctp/advance.ts` | Locked burn → attest → mint state machine |
  | `src/lib/cctp/cctp-store.ts` | Transfer records and terminal guards |
  | `src/lib/cctp/revive.ts` | Revive a failed transfer |
  | `src/lib/cctp/base-cctp.ts` | Base mint with fee-bump retry and already-minted detection |
  | `src/lib/cctp/address-encoding.ts` | Address encoding |
  | `src/lib/offramp/burn-backstop.ts` | Unregistered-burn sweep |
  | `src/components/admin/AdminRecoveryConsole.tsx` | Admin recovery console |
  | `src/lib/wallet/*` | Wallet connection: EVM, Stellar, Solana, and the WalletConnect relay proxy |

---

## 4. User experience

Follow the mockup, which uses the app's existing pieces:
- the content panel
- `AppSelect` for chain dropdowns, with names only and no chain colours
- the form field and label styles from `FormCard`
- the header's glass pill for "Connect wallet"
- the "You'll receive about" card with Show/Hide fee
- `OfframpStatusPanel`-style stepper inside `FlowModal`
- `ResultCard`

**Entry:** a **Bridge** item in the app sidebar and mobile drawer, at the route `/app/bridge`.

**Form**
- **From card:** a chain dropdown (all 8), a Connect wallet pill for that chain's wallet type, the amount with **Max**, the minimum, and the balance.
- **Swap button** between the cards: it swaps chains, wallets and the address. Picking the chain the other card already uses also swaps them. From and To can never be the same chain.
- **To card:** a chain dropdown, a Connect wallet pill, **or** "or paste a {chain} address" with a warning: "Check this address carefully. Bridged USDC can't be recalled or redirected. If this isn't your {chain} address, the funds are lost for good."
- **Transfer speed:** Fast or Standard, with an estimated time on each. It uses the same control as the offramp's USDC/NGN switch. If Fast costs nothing extra on a route, both options still show, with "no extra fee" on Fast.
- **Receive card:**
  - The headline reads "You'll receive on {chain}" with the amount in gold. On Fast it's prefixed "at least".
  - Show fee reveals every line in USDC: You send, Settu fee (0.5%), Fast transfer fee (Fast only), Network fee on {chain}, Estimated time.
- **Button:** "Bridge {amount} USDC". It's disabled until amount, wallet, address and quote are all valid, with a reason shown.

**Wallets on mobile:** connect as the offramp does today. That includes the WalletConnect relay proxy, connecting directly inside a wallet's own browser, and the 1.1.1.1 advice.

**Progress:** the stepper opens over the screen, titled "Bridging {amount} USDC":
1. Confirm transaction in wallet
2. Sending from {source}
3. Verifying the transfer
4. Delivering on {destination}
5. Arrived in your wallet

EVM sources add "Approve USDC" first, the first time only, unless a permit is used (§5.1).

**Result:** the existing `ResultCard`.
- **Success:** "Done! {amount actually received} USDC arrived", "Sent to {short address} on {chain}", and **View transaction**. It also offers **Offramp to naira**, a link to the offramp with that chain preselected.
- **Failure:** what happened, in plain words, and that no funds were lost if that's true. Offer **Try again**, or **Claim it yourself** where it applies (§9).

**History:** bridges appear in the app's transaction history, with the full fee breakdown and both transaction links.

---

## 5. On-chain: Settu bridge contracts (option C)

One contract per chain family. Each one, in a single user-signed call:
1. verifies a **Settu-signed quote** (§6);
2. moves the **fee** (Settu fee plus network fee, in USDC) from the user to Settu's fee wallet;
3. calls Circle's CCTP burn with `amount − fee` and the quote's `destinationDomain`, `mintRecipient`, `maxFee` and finality;
4. emits an event with the quote nonce, user, amounts, destination and recipient, which the server indexes (§9).

**Common rules**
- The contract holds **no balance** after a call.
- It stores only three things: the quote-signer public key, the fee wallet, and the **maximum fee cap** (start at 1%).
- An **owner** account controls the contract. It's separate from the server and held by the business owner. Only the owner can change the signer, the fee wallet or the cap, and can pause the contract.
- **A quote is checked before anything moves.** It must:
  - be signed by the stored signer key,
  - not be expired (about 2 minutes),
  - have a nonce that hasn't been used (stored on-chain),
  - be for this exact user, amount and chain,
  - charge a fee no higher than the cap.
- **`destinationCaller` is zero**, so anyone can submit the mint. Settu normally does it, but the user can always claim it themselves (§9).
- Keep the contracts small, with no upgradeable proxy unless the auditor recommends one. A redeploy plus a config switch is the upgrade path.

### 5.1 EVM (Ethereum, Base, Arbitrum, Optimism, Avalanche, Polygon)
- **Contract:** one Solidity contract, deployed to all six. The quote is EIP-712 typed data, signed by an secp256k1 key.
- **Calls:** it pulls USDC with `transferFrom` (or with **EIP-2612 permit**, so the user signs a permit message instead of sending an approve transaction; native USDC supports it on all six), then calls `TokenMessengerV2.depositForBurn`, or `depositForBurnWithHook` when the destination is Stellar.
- **Safety:** it uses the reentrancy guard and SafeERC20 patterns.
- **Toolchain:** Foundry for building, tests and deployment scripts. *(The builder's call.)*

### 5.2 Stellar (Soroban)
- **Contract:** one Soroban contract. The user authorises one invocation, and that auth tree covers both the fee transfer and the nested `deposit_for_burn` call into Circle's TokenMessengerMinter (`stellarTokenMessengerMinter`).
- **Quote:** signed with ed25519 and checked with Soroban's `ed25519_verify`.
- **Allowances:** match the existing allowance model in `stellar-cctp.ts`, or replace it if the nested auth makes it unnecessary.

### 5.3 Solana (Anchor program)
- **Program:** one Anchor program. In one transaction it verifies the quote through an **ed25519 signature-verify instruction** read from the instructions sysvar, does an SPL transfer of the fee to Settu's fee token account, and makes a CPI into Circle's TokenMessengerMinterV2 `deposit_for_burn` (or `_with_hook`), using the user as signer and a fresh MessageSent event account.
- **Reuse:** the account layout in `src/lib/solana/deposit-for-burn.ts`, with its vendored IDL.

**One ed25519 signing key may serve both Stellar and Solana.** The EVM chains use the secp256k1 key.

---

## 6. Quotes and the admin fee setting

**Admin console**
- A new setting **"Bridge fee (%)"** applies to every route, starting at **0.5%**.
- It's stored server-side (Redis key, with an audit entry recording who, when, old value and new value).
- It's validated to be no higher than the lowest on-chain cap.
- A change applies to the next quote. No contract transactions are needed.

**The `POST /api/bridge/quote` endpoint**
- **Takes:** source chain, destination chain, amount, Fast or Standard, user's source address, recipient.
- **Returns:** the signed quote, plus the breakdown the UI shows, plus `expiresAt`.

**How the quote is computed**
- **Settu fee:** amount × fee setting.
- **Fast fee:** from Iris, for this source and destination. That value is the `maxFee` passed to CCTP.
- **Network fee:** the destination mint gas, converted to USDC, plus a safety margin (the builder picks it and documents it). The conversion is `gasPrice × gasUsed` in the native token, then native/USD.
  - For Solana, add the ATA rent if the recipient has no USDC account yet.
  - For Stellar, add the forwarder mint fee in XLM.
- **The native/USD price source** is the builder's choice. It must be reliable and fail closed: if the price is missing, there's no quote.
- **Guaranteed receive amount:** amount − Settu fee − network fee − maxFee.

**Fail closed.** If any input is missing (price, Iris fee, gas estimate), there's no quote. The UI says "Couldn't get a price right now — try again in a moment".

**Signer keys**
- They're held server-side, like the existing hot wallet keys.
- They're used only for quotes. They're never the contract owner and never a relayer.

---

## 7. Amounts: what's shown is what arrives

- All Settu charges (fee and network fee) are taken **on the source chain** by the contract. Nothing is deducted on the destination chain.
- **Standard:** Circle charges nothing, so the user receives exactly the amount shown.
- **Fast:** Circle charges at most `maxFee`, the amount the quote shows, so the user receives the amount shown or slightly more. The UI says "at least".
- If Circle's Fast fee rises above the quote between quoting and burning, CCTP falls back to Standard speed. The user still receives at least the amount shown. Say so in the stepper ("Taking the standard route — still on its way").
- The success card and history show the **actual amount received**, read from the destination mint.
- **The quote expires.** If it expires before the user signs, re-quote. If the amount changes by any amount, show the new breakdown and require confirmation again.

---

## 8. Destination address validation

The address is validated **as the user types**. The Bridge button stays disabled until it passes. Errors appear under the field in the existing error red, like the offramp's account-number errors.

**Format, per destination**
- **EVM:** `0x` plus 40 hex characters. If mixed case, the EIP-55 checksum must match.
- **Solana:** valid base58 that decodes to 32 bytes.
- **Stellar:** a valid `G…` strkey with a correct checksum. Reject `M…`, `C…` and secret keys (`S…`), with a specific message for an `S…` key ("That's a secret key — never paste it anywhere").

**Wrong-family messages**, for example "That's a Stellar address. Base needs an address starting with 0x."

**Live checks, once the format is valid**
- **Stellar:** the account must exist and have a USDC trustline. If not, the bridge is blocked, with steps to add the trustline.
- **Solana:** derive the recipient's USDC ATA. If it doesn't exist, Settu creates it during delivery and its rent is in the network fee line.

**Always rejected:** the zero address, the USDC token contract on that chain, Circle's CCTP contracts, Settu's own bridge contracts and relayer addresses.

**First-time address:** if the user hasn't bridged to this address before (tracked per user wallet), they must tick "I've checked this address" before the button enables.

**Connected wallets** go through the same checks.

**Share the rules.** The validator is one shared module, used by the UI, the quote endpoint and the server before it signs. A quote is never signed for an address that fails.

---

## 9. Reliability: no stalls

| Past offramp failure | Guard in the bridge |
|---|---|
| Transfers only advanced while the user's tab was open | **Server-driven.** When the client registers the source tx, the server schedules follow-up checks itself (e.g. QStash delayed callbacks at +15 s, +30 s, +60 s, then the 5-minute sweep). Each check attests, then mints. Closing the app changes nothing. |
| A burn went through but Settu lost track of it | **Event sweep.** Every bridge emits a Settu contract event, and the 5-minute sweep indexes those events on all 8 chains. Any bridge not in Redis gets created and driven. |
| The relayer ran out of gas | **One relayer per destination** (one EVM key across the 6 EVM chains, one Solana keypair, the existing Stellar CCTP wallet). Low-balance alerts per chain use the `feat/hot-wallet-gas-alert` mechanism, extended to all 8, and the network fee margin covers spikes. |
| Mint transactions got stuck | **Reuse `sendWithFeeBump`** and the already-minted check (`usedNonces`) from `base-cctp.ts`, generalised to every EVM chain. Solana and Stellar get the equivalent: retry with a fresh blockhash or sequence, and check whether it's already received. |
| A Circle attestation expired | **Re-request it automatically** (`reattest`). |
| A `failed` transfer was terminal and needed a manual revive | Retries keep a ceiling, but a `failed` bridge raises an admin alert and shows in the console with **Revive**. |
| A bridge got stuck anyway | **Self-claim.** Because `destinationCaller` is zero, after a set delay (about 30 minutes past attestation) the user sees **Claim it yourself**. Their wallet submits the mint on the destination chain, and they pay that gas. Their funds never depend on Settu being up. |
| Browser streams reconnected forever (PR #86) | **No streams.** The client polls `GET /api/bridge/{id}` every ~5 s **only while the page is visible**, and stops at a final status or after 20 minutes. It then shows "Still on its way — we'll keep going in the background" with the tx links. |

**Status record:** `cctp-store` gets a `direction: "bridge"` transfer, keyed by source tx, with:
- the quote
- source and destination chains
- recipient
- fee lines
- amounts: sent, guaranteed and received
- both tx hashes
- timestamps

The existing `advance.ts` state machine and terminal guards apply. The mint step is picked by destination family.

**Admin console additions**
- a bridge list with status
- **Revive** and **Retry mint** actions
- relayer balances on all 8 chains
- the fee setting

---

## 10. Testing

- **Unit tests** for:
  - address validation on every chain, including the wrong-family and rejected cases
  - quote math and decimal handling
  - signing and verifying quotes
  - status transitions
- **Contract tests** on each platform (Foundry, Soroban tests, Anchor tests):
  - fee and burn amounts are correct, and no balance is left in the contract
  - expired quotes, reused nonces, a fee over the cap, and a wrong user or amount are all rejected
  - pause works
  - only the owner can change settings
- **End-to-end on testnets:**
  - at least one real bridge from and to each chain family (EVM↔EVM, EVM↔Solana, EVM↔Stellar, Solana↔Stellar), on both Fast and Standard
  - one bridge with the tab closed mid-way, which must still complete
  - one self-claim
- **Amounts:** for every testnet bridge, assert that the delivered amount is at least the amount shown.

---

## 11. Decided, as decided

These are the owner's decisions:
- **All 8 chains** as source and destination.
- **Fast/Standard** toggle.
- **The user pays** the costs.
- **0.5% platform fee** to start, changeable from the admin console with **one setting for all chains**.
- **Fast fee** shown separately.
- **Settu claims on the destination** and the gas is charged in USDC.
- **Option C:** Settu's own contract on each chain, with the fee taken in the same transaction as the bridge.
- **Allbridge-style From/To cards**, each with its own chain picker and wallet connect.
- **The swap button** swaps the cards.
- **Pasting an address is allowed, with a warning.**
- **Destination addresses are validated** per chain before the user can proceed.
- **The stepper says "Verifying the transfer".**
- **The success and failure cards show the wallet and the amount.**
- **Branch-only on the remote.**

These are my calls in the design, which the owner can override:
- Signed quotes, with an on-chain fee cap (1%), rather than storing the fee on-chain.
- `destinationCaller` zero, plus **Claim it yourself**.
- "At least" wording for Fast.
- Settu creates a missing Solana USDC account and charges its rent in the network fee.
- Ticking "I've checked this address" for a first-time address.
- Server-driven completion with polling only while the page is visible, and no streams.
- Testnets on this branch, with mainnet after an audit.

---

## 12. Left to the builder

- Toolchains and project layout for the three contract families. A `contracts/` directory at the repo root is the suggestion.
- The native/USD price source, and the network-fee safety margin.
- Exact retry and scheduling intervals, within the rules in §9.
- Whether EVM uses permit everywhere or an approve fallback.
- Minimum bridge amount. It must be higher than the fees; propose one and put it in config.
- Test fixtures and testnet funding.

**Before any mainnet use:** an external security audit of all three contract families, an owner key held in a hardware wallet or multisig, and a production review of relayer balances and alerts. None of this blocks the branch.
