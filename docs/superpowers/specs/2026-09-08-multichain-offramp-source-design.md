# Multi-chain offramp source support — design

**Status:** approved by user, ready for implementation planning
**Date:** 2026-09-08

## Goal

Today, offramp only accepts USDC burned from a Stellar wallet. This adds
support for burning USDC from **EVM chains** too — a user can bring USDC
from Ethereum, Arbitrum, Optimism, Avalanche, Polygon, or Base itself, and
it settles through the exact same Paycrest fiat-payout pipeline that
already exists. Settlement remains Base throughout; only the *source* of
the USDC changes.

Solana and other non-EVM chains are explicitly out of scope for this
phase — a deliberate decision, not an oversight, given how different
Solana's wallet/tx stack is from the EVM chains' shared one. A later phase
can add it following the same shape of design.

## Scope

**In scope (this phase):**
- New source chains: Ethereum, Arbitrum, Optimism, Avalanche, Polygon (via
  CCTP burn→mint-on-Base), plus Base itself (via a direct USDC transfer,
  no CCTP needed).
- A chain-selector dropdown in the offramp UI.
- WalletConnect-based wallet connection for all six EVM entries, parallel
  to (not replacing) the existing Stellar Wallets Kit connection.
- A new permanent transaction-history record spanning all source chains.
- Per-chain fee/gas display accuracy (CCTP bridge fee is not always 0 bps
  like Stellar→Base is today; source-chain gas is not negligible like
  Stellar's is).

**Out of scope (this phase):**
- Solana or any other non-EVM source chain.
- Onramp (fiat → USDC) gaining multi-chain destination support — onramp is
  untouched by this design.
- Simultaneous multi-wallet sessions (Stellar + EVM connected at once) —
  switching chains replaces the active connection, by explicit choice.
- All 24 of Circle's currently-listed CCTP EVM chains — starting with 5
  curated chains plus Base; the architecture makes adding more later cheap
  (a config entry), but that's a follow-up, not this phase.

## Chain configuration model

`constants.ts` currently models exactly one source (Stellar) and one
destination (Base) chain, hardcoded. This adds a source-chain config table,
additive — the existing Stellar↔Base pair is untouched.

```ts
interface DirectSourceChainConfig {
  kind: "direct";
  key: "base";
  label: string;
  chainId: number;
  usdcAddress: `0x${string}`;
  rpcUrl: string;
}

interface CctpBridgeSourceChainConfig {
  kind: "cctp-bridge";
  key: "ethereum" | "arbitrum" | "optimism" | "avalanche" | "polygon";
  label: string;
  chainId: number;
  cctpDomain: number;
  usdcAddress: `0x${string}`;
  rpcUrl: string;
  tokenMessengerV2: `0x${string}`;
}

type SourceChainConfig = DirectSourceChainConfig | CctpBridgeSourceChainConfig;

// EVM-only. Stellar deliberately does NOT live in this table — its config
// shape (network passphrase, Soroban contract IDs, 7-decimal USDC) has
// nothing in common with the EVM chains' shape above, and per the wallet
// section below it already has its own complete, untouched code path via
// the existing CCTP_CONFIG. The dropdown's UI layer adds a literal
// "stellar" option alongside these six and special-cases it to that
// existing path — it's a sibling choice in the UI, not an entry here.
export const EVM_SOURCE_CHAINS: Record<string, SourceChainConfig> = {
  base: { kind: "direct", key: "base", ... },
  ethereum: { kind: "cctp-bridge", key: "ethereum", cctpDomain: 0, ... },
  arbitrum: { kind: "cctp-bridge", key: "arbitrum", cctpDomain: 3, ... },
  optimism: { kind: "cctp-bridge", key: "optimism", cctpDomain: 2, ... },
  avalanche: { kind: "cctp-bridge", key: "avalanche", cctpDomain: 1, ... },
  polygon: { kind: "cctp-bridge", key: "polygon", cctpDomain: 7, ... },
};
```

Circle deploys the *same* `TokenMessengerV2` address
(`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`) on every one of these chains
— already the address this codebase uses for Base. Each chain's own native
USDC contract address is the only address that genuinely varies per chain
and needs individual verification against Circle's raw docs before it goes
into this table, same standard as every other address already in
`constants.ts`. CCTP domain IDs, per Circle's current published list:
Ethereum 0, Avalanche 1, OP Mainnet 2, Arbitrum 3, Polygon PoS 7.

Base is modeled with `kind: "direct"` because it needs no CCTP burn at
all — bridging Base to itself would be a pointless round-trip (~8-20s
extra wait, extra gas, and CCTP same-domain burns may not even be valid).
A `"direct"`-kind chain skips the entire CCTP pipeline described below.

## Wallet connection & chain-selection UX

A `sourceChain` selector in the offramp panel, defaulting to `"stellar"`
(today's only option), with the six new entries added. Selecting a chain
happens before connecting a wallet.

Two independent, parallel wallet-connection paths:
- `sourceChain === "stellar"` → today's flow, completely untouched
  (Stellar Wallets Kit).
- Any EVM chain selected → a new `useEvmWallet` hook, mirroring
  `useStellarWallet`'s shape (`connect`, `disconnect`, `address`,
  `isConnected`), backed by WalletConnect v2.

Per the approved decision, switching the dropdown to a different chain —
EVM→EVM or EVM→Stellar — tears down whatever's currently connected and
requires a fresh connect. There is no simultaneous Stellar+EVM session.

One WalletConnect session covers all six EVM chains: WalletConnect's
EIP-155 namespace supports proposing multiple chain IDs in one pairing, so
switching between two already-paired EVM chains (e.g. Arbitrum →
Polygon) only needs a `wallet_switchEthereumChain` request to the same
session, not a full reconnect. Only switching away from EVM entirely (back
to Stellar) or an explicit disconnect tears the WC session down.

**Risk flagged explicitly**: this app hit an unresolved WalletConnect relay
connectivity issue on the Stellar side earlier (diagnosed but never
root-caused — possibly a Reown/WalletConnect Cloud dashboard config issue,
possibly environment-specific). EVM WalletConnect is WalletConnect's
primary, most mature use case, so this may well not recur — but given it's
the same relay infrastructure and the same project ID, a live EVM
WalletConnect pairing must be smoke-tested and confirmed working **before**
building the rest of the UI around it, not assumed.

## Burn transaction flow & fees

**CCTP-bridge chains**: generalizes `base-cctp.ts`'s existing
`submitBaseBurnWithHook`-style logic — approve, then
`depositForBurn` (no forwarder hook needed here, since the destination is
Base directly, unlike onramp's Base→Stellar leg which routes through
Stellar's `CctpForwarder`). `mintRecipient` is Paycrest's per-order receive
address on Base, exactly as every other offramp direction already sets it.
Parameterized by the selected `CctpBridgeSourceChainConfig` instead of a
hardcoded Base config.

**Fee display, no longer safe to assume near-zero**: Stellar→Base's CCTP
bridge fee happens to be 0 bps today, so the app has never had to show a
real bridge fee. The other source→Base pairs will very likely be non-zero.
The existing `getBurnFeeQuote`/`computeAtomicFee` machinery already
computes arbitrary bps correctly — built for exactly this — so this is a
display-accuracy concern, not a new calculation.

**Source-chain gas display, new**: Stellar's network fee is negligible; an
Ethereum approve+burn could cost several dollars in ETH. The quote screen
needs an estimated source-chain gas cost per selected chain (a view-only
`estimateGas` call — exact cost isn't knowable before signing), and the
pre-flight balance check needs a chain-specific native-gas-token check
(mirroring the existing Stellar XLM-reserve check).

**Base direct-transfer path**: a single `transfer(paycrestReceiveAddress,
amount)` call, signed by the user, submitted, done — no CCTP fee, no
attestation wait, just Base's own gas cost shown. `transfer()` moves
directly from the caller's own balance, so unlike the CCTP path it needs
no prior `approve` step at all.

## Data model & backend tracking

The existing pieces need surprisingly little change, because
`CctpTransferRecord`/`advance.ts` were already written with `sourceDomain`
as a plain number rather than hardcoded to Stellar:

- **`advance.ts` (attest→mint state machine): zero changes.** It already
  fetches attestation using whatever `record.sourceDomain` says, and its
  `direction === "offramp"` branch already calls `submitBaseMint`
  unconditionally — which is exactly right, since offramp always mints on
  Base regardless of where the burn happened. A Stellar-sourced and an
  Ethereum-sourced offramp transfer become identical from this point on.
- **`register-transfer/route.ts`**: currently hardcodes
  `sourceDomain: CCTP_DOMAIN.stellar` — needs to accept the real source
  chain's domain as a parameter. Small, mechanical change.
- **New EVM burn-tx-building route**, mirroring the existing
  `offramp/bridge/build-tx` (which builds an unsigned Stellar XDR
  server-side for the client to sign): builds unsigned EVM calldata
  server-side instead, for the WalletConnect-connected wallet to sign.
  Kept server-side, consistent with the existing pattern, so any RPC
  provider API key stays off the client — there's no server-held private
  key involved here, since this is the user's own funds being burned.
- **USDC decimals**: every EVM chain's USDC is 6-decimal, identically —
  the new chains reuse `base-cctp.ts`'s existing `usdcFloatToBaseInt`/
  `BASE_USDC_DECIMALS` helpers unchanged. Only Stellar needed its own
  7-decimal path, and that stays untouched.
- **`funds-ledger.ts`**: its `chain` field type widens to include the new
  chain keys. Purely a type change, no logic change.

Base's direct-transfer path skips all of the above — no
`CctpTransferRecord`, no attestation polling. Just a transaction-history
entry (below) once the transfer confirms.

## New transaction history record

A genuinely new piece: neither `CctpTransferRecord` (operational, TTL'd,
expires once its job is done) nor `funds-ledger.ts` (deliberately only
logs entries where the platform itself custodies funds — offramp entries
there carry no `wallet`, by design) is a permanent, queryable, per-chain
transaction record. This adds one, `src/lib/offramp/transaction-history.ts`,
same no-TTL philosophy as `funds-ledger.ts`:

```ts
interface OfframpTransactionRecord {
  id: string; // burn/transfer tx hash -- stable, unique per transaction
  sourceChain: "stellar" | "base" | "ethereum" | "arbitrum" | "optimism" | "avalanche" | "polygon";
  connectedAddress: string; // the wallet that actually signed
  amountUsdc: string;
  burnTxHash?: string; // CCTP-bridge chains only
  mintTxHash?: string; // Base-side mint, or Base's own direct-transfer tx hash
  destinationCurrency: string; // e.g. "NGN"
  destinationAmount: string; // fiat payout
  paycrestOrderId?: string;
  status: "pending" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}
```

Written once when the burn/transfer is registered; updated as it
progresses (mint confirmed, Paycrest validated/settled). Indexed two ways:
chronologically (a sorted set, matching the funds ledger's existing
pattern) and by `connectedAddress` (a per-address sorted set), so "this
wallet's past offramps" is a cheap targeted lookup rather than a full scan
— useful for support immediately, and a ready foundation if a "my
transactions" UI is ever built, independent of whether that happens next.

## Error handling & edge cases

- **Wrong network in the connected wallet.** Before building the burn tx,
  explicitly request a network switch (`wallet_switchEthereumChain`) and
  surface a clear "please switch to X in your wallet" message if it's
  rejected, rather than letting a mismatched-chain signature attempt fail
  cryptically.
- **Insufficient native gas on the source chain.** Mirrors the existing
  Stellar XLM-reserve pre-flight check, generalized per chain (ETH, AVAX,
  MATIC, etc.), checked before the wallet is asked to sign, using the gas
  estimate from the burn-flow section above.
- **WalletConnect relay failure/timeout.** Needs its own clear timeout +
  "couldn't reach the wallet relay, try again" message on the EVM connect
  flow — not a silent hang, given the precedent on the Stellar side.
- **Orphaned burn (the register-transfer gap).** The exact incident fixed
  for Stellar offramp — a burn confirms on-chain but the client never
  successfully tells the backend, permanently stranding it — applies
  identically here, per source chain. The same fix (retry the
  register-transfer call + `navigator.sendBeacon` fallback, idempotent
  server-side handling) applies directly; no new mechanism needed.
- **Fee-quote staleness.** Already handled today — the burn tx is built
  fresh immediately before signing, never off a stale cached quote. This
  just needs to keep holding for every new chain, not a new mechanism.

## Testing & rollout

**Unit-testable**: chain config shape/decimal validation, any pure
formatting/estimate-display logic, the transaction-history store's pure
functions — matching this app's existing pattern of unit-testing pure
logic and live-verifying the rest (external RPC/API calls aren't mocked
anywhere in this codebase today).

**Live verification, staged**: all five CCTP-bridge chains share identical
code paths — only config differs — so verify one chain fully end-to-end
first (real burn, real attestation, real mint to a real Paycrest receive
address, real fiat payout) before touching the rest. Arbitrum first: cheap,
fast, high CCTP volume. Once that one genuine transaction confirms the
generalized pipeline works, the remaining four chains are much lower-risk
(identical code, different config) and can follow quickly. Base's
direct-transfer path gets its own separate live check, since it's a
distinct code path.

**Rollout gate**: an env-var-driven allowlist of which chains are actually
selectable in the dropdown, so each chain can go live independently as
it's verified rather than all six shipping the moment the code merges.

## Open risks

- **WalletConnect relay connectivity** — flagged above, needs a smoke test
  before UI work begins. If it turns out to reproduce the same unresolved
  issue as the Stellar attempt, this design's wallet-connection section
  needs to be revisited before implementation continues.
- **Exact USDC contract addresses and domain IDs per chain** — the table
  above lists domain IDs from Circle's currently-published list; each
  chain's USDC address still needs individual raw-doc verification during
  implementation, not carried over from this design doc as-is.
