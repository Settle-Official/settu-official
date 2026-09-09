# Multi-chain Offramp Source Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let offramp accept USDC burned from Ethereum, Arbitrum, Optimism, Avalanche, Polygon, or Base (in addition to today's Stellar-only source), settling through the exact same Paycrest fiat-payout pipeline regardless of source chain.

**Architecture:** A new EVM chain config table + generalized viem-based burn logic (extending the existing `base-cctp.ts` pattern, not adopting a new SDK). CCTP-bridge chains (Ethereum/Arbitrum/Optimism/Avalanche/Polygon) burn → mint on Base via the existing attest/mint state machine, which already needs zero changes. Base itself skips CCTP entirely via a direct ERC20 `transfer()`. Wallet connection is WalletConnect for all six EVM entries, parallel to and independent from the existing Stellar Wallets Kit path — switching chains tears down and requires a fresh connect, no simultaneous multi-wallet session.

**Tech Stack:** viem (already a dependency, used for Base), WalletConnect v2 (`@walletconnect/sign-client`, already a dependency, used earlier for a Stellar mobile attempt), Upstash Redis (existing `cctp-store.ts`/`funds-ledger.ts` pattern), Node's native test runner.

**Spec:** `docs/superpowers/specs/2026-09-08-multichain-offramp-source-design.md`

---

## Implementation status & deviations (updated 2026-09-09)

Tasks 1–10 implemented; Task 11 in progress. Both distinct code paths verified
end-to-end with real funds (2026-09-09): CCTP-bridge via **Arbitrum**, direct
`transfer()` via **Base** — see Task 11 Step 2. Not yet: Optimism / Avalanche /
Polygon / Ethereum spot-checked (config-only), production enabled, `dev` pushed.

Where the build diverged from the plan text below:

- **Wallet connection is not WalletConnect-only.** `useEvmWallet` is
  dual-transport: EIP-6963 injected providers (MetaMask / Rabby / Coinbase
  browser extensions — direct `eth_requestAccounts` / `eth_sendTransaction` /
  `wallet_switchEthereumChain`) **and** WalletConnect (`sign-client`) for mobile.
  New files: `src/lib/evm/injected.ts`, `src/components/EvmConnectModal.tsx`
  (picker). The plan's Task 8 returned a `pairingUri` but nothing rendered it —
  that gap is closed by the modal.
- **`useEvmWallet` lives in `StellarampDashboard`, not `FormCard`** (one session,
  not two hook instances). FormCard stays presentational, fed derived props —
  matching the existing Stellar prop-drilling. The shared top header also
  reflects the EVM wallet + balances for a non-Stellar offramp.
- **Rollout gate env var: `NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED`** (client needs
  it; build-time). Server routes read it too and reject a disabled chain.
- **`gas-fee-options` route** now takes `?sourceChain` — it was Stellar-domain +
  7-decimal hardcoded, a 10× fee-display error for EVM (EVM USDC is 6-decimal).
  Base returns a zero bridge fee (plain transfer).
- **New routes beyond the plan:** `evm-gas-preflight` (native-balance gate),
  `evm-balances` (header/FormCard USDC + native readout).
- **CCTP-bridge submission does approve → wait-for-allowance → burn** (re-polls
  `evm-build-tx`, whose server-side allowance read is the "approve mined" signal)
  rather than firing both calls blind — a blind burn reverts on a slow chain.
- **`buildEvmBurnCalldata` approves ≥1000 USDC headroom** so repeat offramps skip
  the approve, matching the Stellar `build-tx` path.
- `handleExecuteEvmTrade` is a **separate function** duplicating the Paycrest
  quote/order prefix rather than refactoring the working Stellar path; the client
  `Transaction` record reuses `stellarTxHash` for the EVM burn/transfer hash
  (no localStorage schema change).
- Progress modal step label is parameterised (`Submitting on <source chain>`).
- Commit trailer: none (repo convention), overriding the session default.

## Global Constraints

- Solana and non-EVM chains are out of scope this phase — do not add them.
- Launch chain list is exactly: Ethereum, Arbitrum, Optimism, Avalanche, Polygon (CCTP-bridge), Base (direct-transfer). Not all 24 of Circle's listed CCTP chains.
- Switching the chain dropdown tears down the active wallet connection and requires a fresh connect — no simultaneous Stellar + EVM session.
- Every USDC/TokenMessengerV2 contract address must be verified against Circle's raw docs (not trusted from memory or an AI-summarized fetch) before it goes into committed config — this repo's established standard (see `src/lib/cctp/constants.ts`'s own header comment).
- No server-held private key is involved anywhere in this feature — the user's own wallet signs every burn/transfer. Server-side code only builds unsigned tx data.
- Base's direct-transfer path must NOT create a `CctpTransferRecord` or go through `advance.ts` — it has its own, simpler path.
- The WalletConnect EVM smoke test (Task 1) must pass before any task that builds UI around it (Tasks 8+) begins.

---

## Task 1: WalletConnect EVM connectivity smoke test

**Purpose:** De-risk the biggest unknown first. This app hit an unresolved WalletConnect relay issue on the Stellar side earlier; confirm the same relay/project ID actually completes a real EVM pairing before any UI is built around it.

**Files:**
- Create: `scripts/walletconnect-evm-smoke-test.mjs` (throwaway — not part of the shipped app, deleted or left as a standalone diagnostic after this task)

**Interfaces:**
- Consumes: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (existing env var, already used for the earlier Stellar attempt)
- Produces: a pass/fail finding that gates whether the rest of this plan proceeds as-is

- [x] **Step 1: Write the smoke test script**

```js
// scripts/walletconnect-evm-smoke-test.mjs
// Throwaway diagnostic: confirms a real WalletConnect v2 EVM pairing
// completes against the relay this project is configured to use, before
// any application code is built around it. Run manually, watch the
// console output and (if a wallet is available) approve the pairing on
// your phone/extension.
import { SignClient } from "@walletconnect/sign-client";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
if (!projectId) {
  console.error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID not set");
  process.exit(1);
}

const client = await SignClient.init({
  projectId,
  metadata: {
    name: "Settu WC EVM smoke test",
    description: "Diagnostic only",
    url: "https://settu.xyz",
    icons: [],
  },
});

console.log("SignClient initialized. Proposing an EVM session...");

const { uri, approval } = await client.connect({
  requiredNamespaces: {
    eip155: {
      methods: ["eth_sendTransaction", "personal_sign", "wallet_switchEthereumChain"],
      chains: ["eip155:1"], // Ethereum mainnet, just to prove the pairing works
      events: ["chainChanged", "accountsChanged"],
    },
  },
});

console.log("Pairing URI (scan with a wallet, or open on mobile):");
console.log(uri);
console.log("Waiting up to 60s for approval...");

const timeout = setTimeout(() => {
  console.error("TIMED OUT waiting for wallet approval — relay or pairing issue.");
  process.exit(1);
}, 60_000);

try {
  const session = await approval();
  clearTimeout(timeout);
  console.log("SUCCESS — session established:");
  console.log(JSON.stringify(session.namespaces, null, 2));
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  console.error("FAILED:", err);
  process.exit(1);
}
```

- [x] **Step 2: Run it and manually approve from a real wallet**

Run: `node --env-file=.env.local scripts/walletconnect-evm-smoke-test.mjs`

Scan the printed URI with a real EVM wallet (MetaMask mobile, Rainbow, etc.) or open it directly if testing from the same device. Approve the pairing request.

Expected: `SUCCESS — session established:` printed within 60s, with the approved namespace shown.

- [x] **Step 3: Record the outcome**

If it succeeded: proceed to Task 2. Note in the plan (edit this file) which wallet/relay combination was verified working, for future reference.

If it failed or timed out: **stop here**. Do not proceed to Task 8 (UI wiring) or beyond until this is resolved — the spec's wallet-connection section may need revisiting (e.g., checking the WalletConnect/Reown Cloud project's "Allowed Domains" setting, as was suspected but never confirmed during the earlier Stellar attempt). Tasks 2-7 (chain config, burn logic, backend routes, transaction history) don't depend on this and can still proceed while it's investigated.

**Outcome (2026-09-08): PASSED on retry.** Verified working combination:

- Relay: default `wss://relay.walletconnect.org` (no `relayUrl` override needed)
- Project ID: `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` from `.env.local` (the
  `44fc7f05…` value), no "Allowed Domains" change required for a Node script
- Wallet: MetaMask mobile, scanning a QR (the script now renders the pairing URI
  as a PNG at `/tmp/wc-evm-smoke-qr.png` + a terminal QR — recent MetaMask mobile
  dropped the manual URI-paste field, scanner-only)
- Result: session established on `eip155:1`, account returned, full method set
  incl. `eth_sendTransaction` / `wallet_switchEthereumChain` / `personal_sign`

**First attempt earlier the same day FAILED** and was a red herring: the script
crashed inside `@walletconnect/utils` with `Failed to publish custom payload …
tag:undefined` because `relay.walletconnect.org` was returning **SERVFAIL** from
`1.1.1.1` and `8.8.8.8` — a transient WalletConnect/Cloudflare authoritative-DNS
incident (sibling `verify.walletconnect.org` resolved fine throughout). It
cleared within a few hours with no code change. If this recurs: it's upstream
DNS, not this repo — retry later or from another network before touching config.

Tasks 8-11 are unblocked.

- [x] **Step 4: Commit**

```bash
git add scripts/walletconnect-evm-smoke-test.mjs
git commit -m "chore: add WalletConnect EVM connectivity smoke test"
```

---

## Task 2: EVM source chain configuration

**Files:**
- Create: `src/lib/cctp/evm-chains.ts`
- Test: `src/lib/cctp/evm-chains.test.ts`

**Interfaces:**
- Produces: `EVM_SOURCE_CHAINS: Record<EvmChainKey, SourceChainConfig>`, `EvmChainKey` type, `EVM_CCTP_TOKEN_MESSENGER_V2` constant, `isCctpBridgeChain(config): config is CctpBridgeSourceChainConfig` type guard — later tasks (3, 4, 8, 9) import all of these.

- [x] **Step 1: Write the failing config-shape test**

```ts
// src/lib/cctp/evm-chains.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { EVM_SOURCE_CHAINS, isCctpBridgeChain } from "./evm-chains";

test("every EVM source chain has a valid 0x USDC address", () => {
  for (const [key, config] of Object.entries(EVM_SOURCE_CHAINS)) {
    assert.match(config.usdcAddress, /^0x[a-fA-F0-9]{40}$/, `${key} usdcAddress`);
  }
});

test("base is the only direct-kind chain; the rest are cctp-bridge", () => {
  assert.equal(EVM_SOURCE_CHAINS.base.kind, "direct");
  for (const key of ["ethereum", "arbitrum", "optimism", "avalanche", "polygon"] as const) {
    assert.equal(EVM_SOURCE_CHAINS[key].kind, "cctp-bridge");
  }
});

test("cctp-bridge chains have distinct, correct CCTP domain IDs", () => {
  assert.equal(EVM_SOURCE_CHAINS.ethereum.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.ethereum.cctpDomain, 0);
  assert.equal(EVM_SOURCE_CHAINS.avalanche.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.avalanche.cctpDomain, 1);
  assert.equal(EVM_SOURCE_CHAINS.optimism.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.optimism.cctpDomain, 2);
  assert.equal(EVM_SOURCE_CHAINS.arbitrum.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.arbitrum.cctpDomain, 3);
  assert.equal(EVM_SOURCE_CHAINS.polygon.kind === "cctp-bridge" && EVM_SOURCE_CHAINS.polygon.cctpDomain, 7);
});

test("isCctpBridgeChain narrows correctly", () => {
  assert.equal(isCctpBridgeChain(EVM_SOURCE_CHAINS.base), false);
  assert.equal(isCctpBridgeChain(EVM_SOURCE_CHAINS.ethereum), true);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/cctp/evm-chains.test.ts`
Expected: FAIL — `evm-chains.ts` doesn't exist yet.

- [x] **Step 3: Write the config**

USDC addresses below were verified against `developers.circle.com/stablecoins/usdc-contract-addresses` on 2026-09-08 — native Circle-issued USDC, not bridged/legacy variants. **Before merging, independently cross-check each address against that chain's own block explorer** (Etherscan/Arbiscan/etc. contract-verification page) — the same two-source standard `constants.ts`'s Stellar/Base addresses were held to.

```ts
// src/lib/cctp/evm-chains.ts
/**
 * EVM source chains for offramp — a user burning USDC from one of these
 * (or transferring directly, for Base) to fund an offramp order. Settlement
 * is always Base regardless of source; this table only concerns the
 * *source* side.
 *
 * Deliberately does NOT include Stellar — Stellar's config shape (network
 * passphrase, Soroban contract IDs, 7-decimal USDC) has nothing in common
 * with these EVM chains' shape, and it already has its own complete,
 * separate path via CCTP_CONFIG in constants.ts. The chain-selector UI adds
 * "stellar" as a sibling dropdown option and routes it to that existing
 * path entirely outside this table.
 */

export type EvmChainKey =
  | "base"
  | "ethereum"
  | "arbitrum"
  | "optimism"
  | "avalanche"
  | "polygon";

interface DirectSourceChainConfig {
  kind: "direct";
  key: "base";
  label: string;
  chainId: number;
  usdcAddress: `0x${string}`;
  rpcUrlEnvVar: string;
}

interface CctpBridgeSourceChainConfig {
  kind: "cctp-bridge";
  key: Exclude<EvmChainKey, "base">;
  label: string;
  chainId: number;
  cctpDomain: number;
  usdcAddress: `0x${string}`;
  rpcUrlEnvVar: string;
}

export type SourceChainConfig =
  | DirectSourceChainConfig
  | CctpBridgeSourceChainConfig;

// Same TokenMessengerV2 address on every CCTP-bridge EVM chain here —
// verified against Circle's contract-addresses docs (2026-09-08). Kept as
// one shared constant rather than repeated per chain entry, since a real
// difference would mean a genuinely new deployment, not per-chain config.
export const EVM_CCTP_TOKEN_MESSENGER_V2: `0x${string}` =
  "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

export const EVM_SOURCE_CHAINS: Record<EvmChainKey, SourceChainConfig> = {
  base: {
    kind: "direct",
    key: "base",
    label: "Base",
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // same as CCTP_CONFIG.baseUsdc
    rpcUrlEnvVar: "BASE_RPC_URL", // reuses the existing var — same chain
  },
  ethereum: {
    kind: "cctp-bridge",
    key: "ethereum",
    label: "Ethereum",
    chainId: 1,
    cctpDomain: 0,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    rpcUrlEnvVar: "ETHEREUM_RPC_URL",
  },
  arbitrum: {
    kind: "cctp-bridge",
    key: "arbitrum",
    label: "Arbitrum",
    chainId: 42161,
    cctpDomain: 3,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    rpcUrlEnvVar: "ARBITRUM_RPC_URL",
  },
  optimism: {
    kind: "cctp-bridge",
    key: "optimism",
    label: "Optimism",
    chainId: 10,
    cctpDomain: 2,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    rpcUrlEnvVar: "OPTIMISM_RPC_URL",
  },
  avalanche: {
    kind: "cctp-bridge",
    key: "avalanche",
    label: "Avalanche",
    chainId: 43114,
    cctpDomain: 1,
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    rpcUrlEnvVar: "AVALANCHE_RPC_URL",
  },
  polygon: {
    kind: "cctp-bridge",
    key: "polygon",
    label: "Polygon",
    chainId: 137,
    cctpDomain: 7,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    rpcUrlEnvVar: "POLYGON_RPC_URL",
  },
};

export function isCctpBridgeChain(
  config: SourceChainConfig,
): config is CctpBridgeSourceChainConfig {
  return config.kind === "cctp-bridge";
}

/** Rollout gate — see Task 11. Only chains listed here are selectable. */
export function isChainEnabled(key: EvmChainKey): boolean {
  const allowlist = (process.env.EVM_SOURCE_CHAINS_ENABLED || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(key);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/cctp/evm-chains.test.ts`
Expected: PASS, 4/4 tests.

- [x] **Step 5: Add the new RPC env vars to `.env.example`**

Add below the existing `BASE_RPC_URL` line in `.env.example`:

```
# New EVM source chains for offramp (multi-chain support). Each needs its
# own RPC endpoint — no public fallback, matching BASE_RPC_URL's existing
# strict requirement.
ETHEREUM_RPC_URL=
ARBITRUM_RPC_URL=
OPTIMISM_RPC_URL=
AVALANCHE_RPC_URL=
POLYGON_RPC_URL=
# Comma-separated allowlist of which EVM chains are actually selectable in
# the dropdown, e.g. "arbitrum" then later "arbitrum,optimism,ethereum".
# Empty/unset means none are enabled yet.
EVM_SOURCE_CHAINS_ENABLED=
```

- [x] **Step 6: Commit**

```bash
git add src/lib/cctp/evm-chains.ts src/lib/cctp/evm-chains.test.ts .env.example
git commit -m "feat(cctp): add EVM source chain configuration for multi-chain offramp"
```

---

## Task 3: Generalized EVM burn logic

**Purpose:** Extract `base-cctp.ts`'s burn logic into a chain-parameterized version usable for any `CctpBridgeSourceChainConfig`, without touching Base's own onramp-mint code (`submitBaseMint`) or the existing hardcoded Base burn (`submitBaseBurnWithHook`, still used by onramp's Base→Stellar leg — untouched).

**Files:**
- Create: `src/lib/cctp/evm-burn.ts`
- Test: `src/lib/cctp/evm-burn.test.ts`

**Interfaces:**
- Consumes: `EVM_SOURCE_CHAINS`, `EVM_CCTP_TOKEN_MESSENGER_V2`, `CctpBridgeSourceChainConfig` from Task 2; `CCTP_DOMAIN`, `FINALITY_THRESHOLD` from `src/lib/cctp/constants.ts`
- Produces: `usdcFloatToEvmInt(amount: string): bigint`, `buildEvmBurnCalldata(params): { to: \`0x${string}\`; data: \`0x${string}\` }[]` (returns an ordered array — an optional `approve` call, then the `depositForBurn` call, for the client to sign in sequence) — Task 4's route consumes this directly.

- [x] **Step 1: Write the failing tests**

```ts
// src/lib/cctp/evm-burn.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { usdcFloatToEvmInt, buildEvmBurnCalldata } from "./evm-burn";
import { EVM_SOURCE_CHAINS } from "./evm-chains";

test("usdcFloatToEvmInt converts using 6 decimals, same as Base", () => {
  assert.equal(usdcFloatToEvmInt("1.5"), BigInt(1_500_000));
  assert.equal(usdcFloatToEvmInt("0.000001"), BigInt(1));
  assert.equal(usdcFloatToEvmInt("100"), BigInt(100_000_000));
});

test("buildEvmBurnCalldata includes an approve call when allowance is insufficient", () => {
  const calls = buildEvmBurnCalldata({
    chain: EVM_SOURCE_CHAINS.arbitrum,
    amountFloat: "10",
    mintRecipient: "0x" + "11".repeat(20),
    maxFeeAtomic: BigInt(0),
    currentAllowance: BigInt(0),
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].to, EVM_SOURCE_CHAINS.arbitrum.usdcAddress);
  assert.equal(calls[1].to, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
});

test("buildEvmBurnCalldata skips approve when allowance already covers the amount", () => {
  const calls = buildEvmBurnCalldata({
    chain: EVM_SOURCE_CHAINS.arbitrum,
    amountFloat: "10",
    mintRecipient: "0x" + "11".repeat(20),
    maxFeeAtomic: BigInt(0),
    currentAllowance: BigInt(20_000_000), // 20 USDC, more than the 10 being burned
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
});

test("buildEvmBurnCalldata rejects a direct-kind chain", () => {
  assert.throws(() =>
    buildEvmBurnCalldata({
      chain: EVM_SOURCE_CHAINS.base as any,
      amountFloat: "10",
      mintRecipient: "0x" + "11".repeat(20),
      maxFeeAtomic: BigInt(0),
      currentAllowance: BigInt(0),
    }),
  );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/cctp/evm-burn.test.ts`
Expected: FAIL — `evm-burn.ts` doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/lib/cctp/evm-burn.ts
import { encodeFunctionData, type Hex } from "viem";
import {
  EVM_CCTP_TOKEN_MESSENGER_V2,
  isCctpBridgeChain,
  type SourceChainConfig,
} from "./evm-chains";
import { CCTP_DOMAIN, FINALITY_THRESHOLD } from "./constants";

const EVM_USDC_DECIMALS = 6; // identical across every EVM chain's native USDC

export function usdcFloatToEvmInt(amount: string): bigint {
  const [intPart, fracPart = ""] = amount.split(".");
  const frac = fracPart.padEnd(EVM_USDC_DECIMALS, "0").slice(0, EVM_USDC_DECIMALS);
  return (
    BigInt(intPart || "0") * BigInt(10) ** BigInt(EVM_USDC_DECIMALS) + BigInt(frac || "0")
  );
}

const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const DEPOSIT_FOR_BURN_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

function addressToBytes32(address: `0x${string}`): Hex {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

/**
 * Builds the ordered list of unsigned calls (approve, if needed, then
 * depositForBurn) for a user's own wallet to sign to burn USDC on `chain`
 * for offramp. Unlike onramp's Base->Stellar leg, this needs no forwarder
 * hook -- the destination is Base directly (Paycrest's receive address),
 * not routed through Stellar's CctpForwarder -- so this calls
 * depositForBurn, not depositForBurnWithHook, and destinationCaller is
 * left as the zero address (no restriction on who submits the mint).
 */
export function buildEvmBurnCalldata(params: {
  chain: SourceChainConfig;
  amountFloat: string;
  mintRecipient: `0x${string}`; // Paycrest's Base receive address for this order
  maxFeeAtomic: bigint;
  currentAllowance: bigint;
  fast?: boolean;
}): { to: `0x${string}`; data: `0x${string}` }[] {
  if (!isCctpBridgeChain(params.chain)) {
    throw new Error(
      `buildEvmBurnCalldata called for a non-CCTP-bridge chain: ${params.chain.key}`,
    );
  }

  const amount = usdcFloatToEvmInt(params.amountFloat);
  const calls: { to: `0x${string}`; data: `0x${string}` }[] = [];

  if (params.currentAllowance < amount) {
    calls.push({
      to: params.chain.usdcAddress,
      data: encodeFunctionData({
        abi: ERC20_APPROVE_ABI,
        functionName: "approve",
        args: [EVM_CCTP_TOKEN_MESSENGER_V2, amount],
      }),
    });
  }

  calls.push({
    to: EVM_CCTP_TOKEN_MESSENGER_V2,
    data: encodeFunctionData({
      abi: DEPOSIT_FOR_BURN_ABI,
      functionName: "depositForBurn",
      args: [
        amount,
        CCTP_DOMAIN.base,
        addressToBytes32(params.mintRecipient),
        params.chain.usdcAddress,
        addressToBytes32("0x0000000000000000000000000000000000000000"),
        params.maxFeeAtomic,
        params.fast === false ? FINALITY_THRESHOLD.standard : FINALITY_THRESHOLD.fast,
      ],
    }),
  });

  return calls;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/cctp/evm-burn.test.ts`
Expected: PASS, 4/4 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/cctp/evm-burn.ts src/lib/cctp/evm-burn.test.ts
git commit -m "feat(cctp): add chain-agnostic EVM burn calldata builder"
```

---

## Task 4: EVM burn-tx-building API route

**Purpose:** Server-side route that reads on-chain allowance, fetches the live CCTP fee quote, and returns unsigned calldata for the client's WalletConnect-connected wallet to sign — mirrors `offramp/bridge/build-tx`'s existing Stellar pattern (server builds, client signs).

**Files:**
- Create: `src/app/api/offramp/bridge/evm-build-tx/route.ts`

**Interfaces:**
- Consumes: `EVM_SOURCE_CHAINS`, `isCctpBridgeChain` (Task 2); `buildEvmBurnCalldata`, `usdcFloatToEvmInt` (Task 3); `getBurnFeeQuote`, `computeAtomicFee` (existing, `src/lib/cctp/iris-client.ts`); `withRetry`, `isNetworkFetchError` (existing, `src/lib/cctp/retry.ts`)
- Produces: `POST` endpoint returning `{ calls: { to, data }[], chainId: number }` — Task 8 (UI) calls this before asking the wallet to sign.

- [x] **Step 1: Write the route**

```ts
// src/app/api/offramp/bridge/evm-build-tx/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { EVM_SOURCE_CHAINS, isCctpBridgeChain, type EvmChainKey } from "@/lib/cctp/evm-chains";
import { buildEvmBurnCalldata, usdcFloatToEvmInt } from "@/lib/cctp/evm-burn";
import { getBurnFeeQuote, computeAtomicFee } from "@/lib/cctp/iris-client";
import { CCTP_DOMAIN } from "@/lib/cctp/constants";
import { withRetry, isNetworkFetchError } from "@/lib/cctp/retry";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, fromAddress, toAddress, sourceChain } = body;

    if (!validateAmount(amount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!validateAddress(fromAddress, "base")) {
      return NextResponse.json({ error: "Invalid source wallet address" }, { status: 400 });
    }
    if (!validateAddress(toAddress, "base")) {
      return NextResponse.json({ error: "Invalid Paycrest receive address" }, { status: 400 });
    }
    const chainConfig = EVM_SOURCE_CHAINS[sourceChain as EvmChainKey];
    if (!chainConfig || !isCctpBridgeChain(chainConfig)) {
      return NextResponse.json(
        { error: `${sourceChain} is not a supported CCTP-bridge source chain` },
        { status: 400 },
      );
    }

    const rpcUrl = process.env[chainConfig.rpcUrlEnvVar];
    if (!rpcUrl) {
      throw new Error(`${chainConfig.rpcUrlEnvVar} not configured`);
    }

    const result = await withRetry(async () => {
      const publicClient = createPublicClient({ transport: http(rpcUrl) });

      const allowance = await publicClient.readContract({
        address: chainConfig.usdcAddress,
        abi: ERC20_ALLOWANCE_ABI,
        functionName: "allowance",
        args: [fromAddress, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"],
      });

      const feeQuote = await getBurnFeeQuote({
        sourceDomain: chainConfig.cctpDomain,
        destDomain: CCTP_DOMAIN.base,
      });
      const amountAtomic = usdcFloatToEvmInt(amount);
      const maxFeeAtomic = computeAtomicFee(feeQuote.minimumFeeBps, amountAtomic);

      const calls = buildEvmBurnCalldata({
        chain: chainConfig,
        amountFloat: amount,
        mintRecipient: toAddress,
        maxFeeAtomic,
        currentAllowance: allowance,
      });

      return { calls, chainId: chainConfig.chainId };
    });

    return NextResponse.json(result);
  } catch (error: any) {
    const msg = error.message || "";
    const userMessage = isNetworkFetchError(error)
      ? "Couldn't reach the blockchain network right now. Please try again in a moment."
      : msg || "Failed to build transaction";
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
```

- [x] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors referencing `evm-build-tx`.

- [x] **Step 3: Manual live check against one chain (requires `ARBITRUM_RPC_URL` set)**

```bash
curl -sS -X POST http://localhost:3000/api/offramp/bridge/evm-build-tx \
  -H "Content-Type: application/json" \
  -d '{"amount":"1","fromAddress":"0x0000000000000000000000000000000000dEaD","toAddress":"0x0000000000000000000000000000000000dEaD","sourceChain":"arbitrum"}'
```

Expected: a 200 response with a `calls` array (an `approve` call + a `depositForBurn` call, since the dead-address allowance is 0) and `chainId: 42161`. A malformed/zero address is fine here — this only proves the route builds calldata correctly, not that it's a real transferable wallet.

- [x] **Step 4: Commit**

```bash
git add src/app/api/offramp/bridge/evm-build-tx/route.ts
git commit -m "feat(offramp): add EVM burn-tx-building route for multi-chain source"
```

---

## Task 5: Base direct-transfer route

**Purpose:** The simpler, separate path for Base as a source chain — no CCTP, just a plain `transfer()` built for the user's wallet to sign.

**Files:**
- Create: `src/app/api/offramp/bridge/base-direct-tx/route.ts`

**Interfaces:**
- Consumes: `EVM_SOURCE_CHAINS.base` (Task 2)
- Produces: `POST` endpoint returning `{ to, data, chainId }` (a single call, no approve needed) — Task 8 consumes this for the Base-selected case.

- [x] **Step 1: Write the route**

```ts
// src/app/api/offramp/bridge/base-direct-tx/route.ts
import { NextRequest, NextResponse } from "next/server";
import { encodeFunctionData } from "viem";
import { EVM_SOURCE_CHAINS } from "@/lib/cctp/evm-chains";
import { usdcFloatToEvmInt } from "@/lib/cctp/evm-burn";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { amount, toAddress } = body;

    if (!validateAmount(amount)) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    if (!validateAddress(toAddress, "base")) {
      return NextResponse.json({ error: "Invalid Paycrest receive address" }, { status: 400 });
    }

    const base = EVM_SOURCE_CHAINS.base;
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [toAddress, usdcFloatToEvmInt(amount)],
    });

    return NextResponse.json({
      to: base.usdcAddress,
      data,
      chainId: base.chainId,
    });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to build transfer" },
      { status: 500 },
    );
  }
}
```

- [x] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors referencing `base-direct-tx`.

- [x] **Step 3: Manual check**

```bash
curl -sS -X POST http://localhost:3000/api/offramp/bridge/base-direct-tx \
  -H "Content-Type: application/json" \
  -d '{"amount":"1","toAddress":"0x0000000000000000000000000000000000dEaD"}'
```

Expected: `{"to":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","data":"0xa9059cbb...","chainId":8453}` — `to` is Base's USDC contract, `data` starts with `0xa9059cbb` (the `transfer` function selector).

- [x] **Step 4: Commit**

```bash
git add src/app/api/offramp/bridge/base-direct-tx/route.ts
git commit -m "feat(offramp): add Base direct-transfer route (no CCTP needed)"
```

---

## Task 6: Transaction history store

**Files:**
- Create: `src/lib/offramp/transaction-history.ts`
- Test: `src/lib/offramp/transaction-history.test.ts`
- Create: `src/app/api/offramp/bridge/base-direct-register/route.ts` (Step 6 below)

**Interfaces:**
- Produces: `OfframpTransactionRecord` interface, `OfframpSourceChain` type, `recordTransaction(fields): Promise<OfframpTransactionRecord>`, `updateTransactionStatus(id, status, patch?): Promise<void>`, `listByAddress(address, opts?): Promise<OfframpTransactionRecord[]>`, `buildTransactionRecord(fields)` (pure, for testing), plus the `POST /api/offramp/bridge/base-direct-register` endpoint — Task 7's register-transfer generalization calls `recordTransaction` directly (same process), and Task 9's Base branch calls the new endpoint over HTTP (client-side, can't import server-only Redis code directly).

- [x] **Step 1: Write the failing test for the pure builder**

```ts
// src/lib/offramp/transaction-history.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildTransactionRecord } from "./transaction-history";

test("buildTransactionRecord fills id, timestamps, and default status", () => {
  const record = buildTransactionRecord({
    id: "0xabc",
    sourceChain: "arbitrum",
    connectedAddress: "0x1111111111111111111111111111111111111a",
    amountUsdc: "10.5",
    destinationCurrency: "NGN",
    destinationAmount: "14300.00",
  });
  assert.equal(record.id, "0xabc");
  assert.equal(record.sourceChain, "arbitrum");
  assert.equal(record.status, "pending");
  assert.equal(typeof record.createdAt, "number");
  assert.equal(record.createdAt, record.updatedAt);
});

test("buildTransactionRecord accepts optional burn/mint hashes and order id", () => {
  const record = buildTransactionRecord({
    id: "0xabc",
    sourceChain: "base",
    connectedAddress: "0x1111111111111111111111111111111111111a",
    amountUsdc: "5",
    destinationCurrency: "NGN",
    destinationAmount: "6800.00",
    mintTxHash: "0xdef",
    paycrestOrderId: "order-123",
  });
  assert.equal(record.mintTxHash, "0xdef");
  assert.equal(record.burnTxHash, undefined);
  assert.equal(record.paycrestOrderId, "order-123");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/transaction-history.test.ts`
Expected: FAIL — module doesn't exist yet.

- [x] **Step 3: Write the implementation**

```ts
// src/lib/offramp/transaction-history.ts
/**
 * Permanent, queryable record of every offramp transaction across every
 * source chain -- distinct from CctpTransferRecord (operational, TTL'd,
 * expires once its job is done) and funds-ledger.ts (deliberately only
 * logs entries where the platform itself custodies funds -- offramp
 * entries there carry no wallet, by design). This is the one place with
 * the full picture per transaction, permanently, across every chain.
 */

import { Redis } from "@upstash/redis";
import type { EvmChainKey } from "@/lib/cctp/evm-chains";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ENTRY_KEY = (id: string) => `offramp:tx:${id}`;
const CHRONOLOGICAL_INDEX_KEY = "offramp:tx:index";
const ADDRESS_INDEX_KEY = (address: string) =>
  `offramp:tx:by-address:${address.toLowerCase()}`;

export type OfframpSourceChain = "stellar" | EvmChainKey;

export interface OfframpTransactionRecord {
  id: string; // burn/transfer tx hash -- stable, unique per transaction
  sourceChain: OfframpSourceChain;
  connectedAddress: string;
  amountUsdc: string;
  burnTxHash?: string; // CCTP-bridge chains only
  mintTxHash?: string; // Base-side mint, or Base's own direct-transfer tx hash
  destinationCurrency: string;
  destinationAmount: string;
  paycrestOrderId?: string;
  status: "pending" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}

export function buildTransactionRecord(
  fields: Omit<OfframpTransactionRecord, "status" | "createdAt" | "updatedAt"> & {
    status?: OfframpTransactionRecord["status"];
  },
): OfframpTransactionRecord {
  const now = Date.now();
  return {
    ...fields,
    status: fields.status ?? "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export async function recordTransaction(
  fields: Omit<OfframpTransactionRecord, "status" | "createdAt" | "updatedAt"> & {
    status?: OfframpTransactionRecord["status"];
  },
): Promise<OfframpTransactionRecord> {
  const record = buildTransactionRecord(fields);
  await redis.set(ENTRY_KEY(record.id), record); // no `ex` -- permanent
  await redis.zadd(CHRONOLOGICAL_INDEX_KEY, { score: record.createdAt, member: record.id });
  await redis.zadd(ADDRESS_INDEX_KEY(record.connectedAddress), {
    score: record.createdAt,
    member: record.id,
  });
  return record;
}

export async function updateTransactionStatus(
  id: string,
  status: OfframpTransactionRecord["status"],
  patch: Partial<Pick<OfframpTransactionRecord, "mintTxHash" | "paycrestOrderId">> = {},
): Promise<void> {
  const existing = await redis.get<OfframpTransactionRecord>(ENTRY_KEY(id));
  if (!existing) return;
  const updated: OfframpTransactionRecord = {
    ...existing,
    ...patch,
    status,
    updatedAt: Date.now(),
  };
  await redis.set(ENTRY_KEY(id), updated);
}

export async function listByAddress(
  address: string,
  opts: { limit?: number } = {},
): Promise<OfframpTransactionRecord[]> {
  const limit = opts.limit ?? 50;
  const ids = await redis.zrange<string[]>(ADDRESS_INDEX_KEY(address), 0, limit - 1, {
    rev: true,
  });
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<OfframpTransactionRecord>(ENTRY_KEY(id))));
  return records.filter((r): r is OfframpTransactionRecord => r !== null);
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --import ./scripts/register-ts-resolver.mjs --test src/lib/offramp/transaction-history.test.ts`
Expected: PASS, 2/2 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/offramp/transaction-history.ts src/lib/offramp/transaction-history.test.ts
git commit -m "feat(offramp): add permanent cross-chain transaction history store"
```

- [x] **Step 6: Add the Base direct-transfer registration route**

Base's path has no CCTP tracking record, so it needs its own small route to trigger `recordTransaction` after the transfer confirms — the equivalent of what `register-transfer` does for the CCTP-bridge chains, per Task 9 Step 5's Base branch. Same idempotency-on-retry care as `register-transfer` (Task 7): a second call for the same `txHash` must not create a duplicate record.

```ts
// src/app/api/offramp/bridge/base-direct-register/route.ts
import { NextRequest, NextResponse } from "next/server";
import { recordTransaction } from "@/lib/offramp/transaction-history";
import { validateAmount, validateAddress } from "@/lib/offramp/utils/validation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      txHash,
      connectedAddress,
      amountUsdc,
      destinationCurrency,
      destinationAmount,
      paycrestOrderId,
    } = body;

    if (!txHash || !validateAddress(connectedAddress, "base") || !validateAmount(amountUsdc)) {
      return NextResponse.json(
        { error: "txHash, connectedAddress, and amountUsdc are required" },
        { status: 400 },
      );
    }

    const record = await recordTransaction({
      id: txHash,
      sourceChain: "base",
      connectedAddress,
      amountUsdc,
      mintTxHash: txHash, // Base's own transfer tx IS the settlement tx -- no separate mint
      destinationCurrency: destinationCurrency || "NGN",
      destinationAmount: destinationAmount || "0",
      paycrestOrderId,
      status: "completed",
    });

    return NextResponse.json({ id: record.id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to register transaction" },
      { status: 500 },
    );
  }
}
```

Note: `recordTransaction` (Task 6) does an unconditional `redis.set` — for a *first* implementation this is acceptable since Base's flow has no multi-step state to corrupt on a duplicate write (unlike `register-transfer`'s CCTP tracking record, which genuinely can regress an in-progress transfer if blindly overwritten). A duplicate call here just re-writes the same completed record with a fresh `updatedAt`. If that becomes a real problem in practice, add the same check-before-create guard `register-transfer` uses.

- [x] **Step 7: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors referencing `base-direct-register`.

- [x] **Step 8: Commit**

```bash
git add src/app/api/offramp/bridge/base-direct-register/route.ts
git commit -m "feat(offramp): add registration route for Base's direct-transfer path"
```

---

## Task 7: Generalize register-transfer for arbitrary source domains

**Files:**
- Modify: `src/app/api/offramp/bridge/register-transfer/route.ts`
- Modify: `src/lib/ledger/funds-ledger.ts` (widen the `chain` field type)

**Interfaces:**
- Consumes: `OfframpSourceChain`, `recordTransaction` (Task 6)
- Produces: the route now accepts `sourceDomain: number` and `sourceChain: OfframpSourceChain` in its body, defaulting to Stellar's values when omitted (backward-compatible with the existing Stellar-only client) — Task 8's UI passes these explicitly for EVM sources.

- [x] **Step 1: Read the current route to confirm the exact diff target**

Run: `cat src/app/api/offramp/bridge/register-transfer/route.ts`

(No test to write first here — this is a small, mechanical widening of an existing route with no new pure logic; verified via the manual check in Step 3 instead, consistent with how this route has no existing test coverage.)

- [x] **Step 2: Widen the route to accept an explicit source domain/chain**

Replace the body of `POST` in `src/app/api/offramp/bridge/register-transfer/route.ts` — keep the existing idempotency check (`getCctpTransfer` before `createCctpTransfer`) exactly as-is, and change only the domain/chain handling:

```ts
import { NextRequest, NextResponse } from "next/server";
import { createCctpTransfer, getCctpTransfer } from "@/lib/cctp/cctp-store";
import { recordLedgerEntry } from "@/lib/ledger/funds-ledger";
import { CCTP_DOMAIN } from "@/lib/cctp/constants";
import { EVM_SOURCE_CHAINS, type EvmChainKey } from "@/lib/cctp/evm-chains";
import { recordTransaction } from "@/lib/offramp/transaction-history";
import type { OfframpSourceChain } from "@/lib/offramp/transaction-history";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      burnTxHash,
      mintRecipient,
      amount,
      paycrestOrderId,
      sourceChain, // "stellar" | EvmChainKey — defaults to "stellar" for the existing client
      connectedAddress, // the wallet that signed the burn -- for transaction history
    } = body;

    if (!burnTxHash || !mintRecipient || !amount) {
      return NextResponse.json(
        { error: "burnTxHash, mintRecipient, and amount are required" },
        { status: 400 },
      );
    }

    const resolvedSourceChain: OfframpSourceChain = sourceChain || "stellar";
    const sourceDomain =
      resolvedSourceChain === "stellar"
        ? CCTP_DOMAIN.stellar
        : (EVM_SOURCE_CHAINS[resolvedSourceChain as EvmChainKey] as any)?.cctpDomain;
    if (sourceDomain === undefined) {
      return NextResponse.json(
        { error: `Unknown or non-bridging source chain: ${resolvedSourceChain}` },
        { status: 400 },
      );
    }

    const existing = await getCctpTransfer(burnTxHash);
    if (existing) {
      return NextResponse.json({ transferId: existing.id });
    }

    const record = await createCctpTransfer({
      id: burnTxHash,
      direction: "offramp",
      sourceDomain,
      destDomain: CCTP_DOMAIN.base,
      burnTxHash,
      mintRecipient,
      status: "burned",
      paycrestOrderId,
    });

    await recordLedgerEntry({
      direction: "offramp",
      chain: resolvedSourceChain,
      asset: "USDC",
      amount,
      txHash: burnTxHash,
      orderId: paycrestOrderId,
    });

    if (connectedAddress) {
      void recordTransaction({
        id: burnTxHash,
        sourceChain: resolvedSourceChain,
        connectedAddress,
        amountUsdc: amount,
        burnTxHash,
        destinationCurrency: "NGN", // widen if/when other corridors reach this route
        destinationAmount: "0", // filled in once the payout is known -- see Task 9's note
        paycrestOrderId,
      });
    }

    return NextResponse.json({ transferId: record.id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to register transfer" },
      { status: 500 },
    );
  }
}
```

- [x] **Step 3: Widen `funds-ledger.ts`'s `chain` field type**

In `src/lib/ledger/funds-ledger.ts`, change:

```ts
chain: "base" | "stellar";
```

to:

```ts
import type { OfframpSourceChain } from "@/lib/offramp/transaction-history";

chain: "base" | OfframpSourceChain; // "base" kept for onramp's own base_hot_wallet entries
```

- [x] **Step 4: Verify compilation and existing tests still pass**

Run: `npx tsc --noEmit && npm test`
Expected: no errors, all existing tests still passing (this task adds no new tests of its own — it's a widening of existing, previously Stellar-only behavior; the existing `register-transfer` idempotency behavior is unchanged and was never unit-tested before this task either).

- [x] **Step 5: Manual check that the Stellar path still works unchanged**

```bash
curl -sS -X POST http://localhost:3000/api/offramp/bridge/register-transfer \
  -H "Content-Type: application/json" \
  -d '{"burnTxHash":"testhash123","mintRecipient":"0x0000000000000000000000000000000000dEaD","amount":"1"}'
```

Expected: `{"transferId":"testhash123"}` — omitting `sourceChain` defaults to Stellar's domain, exactly matching pre-change behavior.

- [x] **Step 6: Commit**

```bash
git add src/app/api/offramp/bridge/register-transfer/route.ts src/lib/ledger/funds-ledger.ts
git commit -m "feat(offramp): generalize register-transfer for arbitrary EVM source chains"
```

---

## Task 8: WalletConnect EVM wallet hook

**Precondition:** Task 1's smoke test passed.

**Files:**
- Create: `src/lib/evm/walletconnect-adapter.ts`
- Create: `src/hooks/useEvmWallet.ts`

**Interfaces:**
- Consumes: `EvmChainKey`, `EVM_SOURCE_CHAINS` (Task 2)
- Produces: `useEvmWallet()` returning `{ address: string | null; isConnected: boolean; isConnecting: boolean; connect(): Promise<void>; disconnect(): Promise<void>; switchChain(chainId: number): Promise<void>; signAndSendCalls(calls: {to, data}[], chainId: number): Promise<string[]> }` — Task 10 (UI) consumes this directly, matching `useStellarWallet`'s existing shape.

- [x] **Step 1: Write the WalletConnect session adapter**

```ts
// src/lib/evm/walletconnect-adapter.ts
import { SignClient } from "@walletconnect/sign-client";
import type { EvmChainKey } from "@/lib/cctp/evm-chains";
import { EVM_SOURCE_CHAINS } from "@/lib/cctp/evm-chains";

let clientPromise: ReturnType<typeof SignClient.init> | null = null;

function getClient() {
  if (!clientPromise) {
    const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (!projectId) throw new Error("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is missing");
    clientPromise = SignClient.init({
      projectId,
      metadata: {
        name: "Settu",
        description: "Stellar USDC <-> fiat, multi-chain",
        url: typeof window !== "undefined" ? window.location.origin : "https://settu.xyz",
        icons: [],
      },
    });
  }
  return clientPromise;
}

const ALL_CHAIN_IDS = Object.values(EVM_SOURCE_CHAINS).map((c) => `eip155:${c.chainId}`);

export interface EvmSession {
  topic: string;
  address: `0x${string}`;
}

/**
 * Proposes one WalletConnect session covering every EVM chain this app
 * supports at once (WalletConnect's eip155 namespace allows proposing
 * multiple chain IDs in a single pairing) -- so switching between two
 * already-paired chains later is just a wallet_switchEthereumChain
 * request, not a full reconnect. Times out after 60s with a clear error
 * rather than hanging silently, given the unresolved relay issue seen
 * earlier on the Stellar side of this app.
 */
export async function proposeEvmSession(
  onUri: (uri: string) => void,
): Promise<EvmSession> {
  const client = await getClient();
  const { uri, approval } = await client.connect({
    requiredNamespaces: {
      eip155: {
        methods: ["eth_sendTransaction", "personal_sign", "wallet_switchEthereumChain"],
        chains: ALL_CHAIN_IDS,
        events: ["chainChanged", "accountsChanged"],
      },
    },
  });
  if (uri) onUri(uri);

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("Could not reach the WalletConnect relay. Please try again.")),
      60_000,
    ),
  );
  const session = await Promise.race([approval(), timeout]);

  const account = session.namespaces.eip155?.accounts?.[0];
  if (!account) throw new Error("Wallet did not return an EVM account");
  const address = account.split(":")[2] as `0x${string}`;

  return { topic: session.topic, address };
}

export async function disconnectEvmSession(topic: string): Promise<void> {
  const client = await getClient();
  await client.disconnect({
    topic,
    reason: { code: 6000, message: "User disconnected" },
  });
}

export async function requestChainSwitch(topic: string, chainId: number): Promise<void> {
  const client = await getClient();
  await client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    },
  });
}

export async function sendTransaction(
  topic: string,
  chainId: number,
  from: `0x${string}`,
  call: { to: `0x${string}`; data: `0x${string}` },
): Promise<string> {
  const client = await getClient();
  return client.request({
    topic,
    chainId: `eip155:${chainId}`,
    request: {
      method: "eth_sendTransaction",
      params: [{ from, to: call.to, data: call.data }],
    },
  }) as Promise<string>;
}
```

- [x] **Step 2: Write the hook**

```ts
// src/hooks/useEvmWallet.ts
"use client";

import { useState, useCallback } from "react";
import {
  proposeEvmSession,
  disconnectEvmSession,
  requestChainSwitch,
  sendTransaction,
} from "@/lib/evm/walletconnect-adapter";

export function useEvmWallet() {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pairingUri, setPairingUri] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    setPairingUri(null);
    try {
      const session = await proposeEvmSession((uri) => setPairingUri(uri));
      setAddress(session.address);
      setTopic(session.topic);
    } finally {
      setIsConnecting(false);
      setPairingUri(null);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (topic) await disconnectEvmSession(topic);
    setAddress(null);
    setTopic(null);
  }, [topic]);

  const switchChain = useCallback(
    async (chainId: number) => {
      if (!topic) throw new Error("No wallet connected");
      await requestChainSwitch(topic, chainId);
    },
    [topic],
  );

  const signAndSendCalls = useCallback(
    async (calls: { to: `0x${string}`; data: `0x${string}` }[], chainId: number) => {
      if (!topic || !address) throw new Error("No wallet connected");
      const hashes: string[] = [];
      for (const call of calls) {
        hashes.push(await sendTransaction(topic, chainId, address, call));
      }
      return hashes;
    },
    [topic, address],
  );

  return {
    address,
    isConnected: !!address,
    isConnecting,
    pairingUri,
    connect,
    disconnect,
    switchChain,
    signAndSendCalls,
  };
}
```

- [x] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors referencing `walletconnect-adapter` or `useEvmWallet`.

- [x] **Step 4: Commit**

```bash
git add src/lib/evm/walletconnect-adapter.ts src/hooks/useEvmWallet.ts
git commit -m "feat(offramp): add WalletConnect-backed EVM wallet hook"
```

---

## Task 9: Chain dropdown, wallet routing, and submission orchestration

**Files:**
- Modify: `src/components/FormCard.tsx` (dropdown UI + connect-button routing only)
- Modify: `src/components/StellarampDashboard.tsx` (submission orchestration — this is where the existing Stellar equivalent, `handleInitiateOfframp` + the `registerBridgeTransfer` retry helper, already lives; EVM sources follow the same shape, not a new location)

**Interfaces:**
- Consumes: `EVM_SOURCE_CHAINS`, `isChainEnabled`, `isCctpBridgeChain` (Task 2); `useEvmWallet` (Task 8)
- Produces: a `sourceChain` state and dropdown wired into the existing amount/wallet-connect flow; `onInitiateOfframp` now branches by chain before doing any of its existing Stellar-specific work.

- [x] **Step 1: Read the current wallet-connect/currency UI and the existing submission orchestration to confirm exact insertion points**

Run: `grep -n "isConnected\|OFFRAMP CURRENCY\|onConnect" src/components/FormCard.tsx`
Run: `grep -n "handleInitiateOfframp\|registerBridgeTransfer\|register-transfer" src/components/StellarampDashboard.tsx`

- [x] **Step 2: Add the source-chain dropdown (FormCard.tsx)**

Add a `sourceChain` state (`useState<"stellar" | EvmChainKey>("stellar")`) alongside the existing `amountMode` state, and a `SelectField` for it above the existing amount `InputField`, listing `"Stellar"` plus every `EVM_SOURCE_CHAINS` entry where `isChainEnabled(key)` is true. Changing it calls `disconnect()` on whichever wallet (Stellar or EVM) is currently connected, per the "switching replaces the connection" decision, then clears `amount`/`quote` the same way the existing `amountMode` toggle already does. `sourceChain` is passed up alongside the rest of `tradeData` in the existing `onInitiateOfframp` callback shape.

- [x] **Step 3: Route the "CONNECT WALLET" button by source chain (FormCard.tsx)**

When `sourceChain === "stellar"`, the button keeps calling the existing Stellar `onConnect` prop, unchanged. When an EVM chain is selected, it calls `useEvmWallet().connect()` instead, and the displayed connected address comes from `useEvmWallet().address` rather than the Stellar wallet's address.

- [x] **Step 4: Add a retried, idempotency-safe registration helper for the two new source kinds (StellarampDashboard.tsx)**

This directly reuses the pattern already fixed for the exact same failure mode on Stellar offramp (a confirmed on-chain burn whose registration call fails and never gets retried, permanently stranding it) — same shape as the existing `registerBridgeTransfer` helper already in this file, not a new design:

```ts
/**
 * Registers a confirmed EVM burn/transfer with the backend, retrying on
 * failure and falling back to sendBeacon -- same reasoning and shape as
 * registerBridgeTransfer above (Stellar offramp hit this exact failure
 * mode for real: a confirmed burn whose registration call silently failed
 * and was never retried, permanently orphaning it). Routes to
 * register-transfer for CCTP-bridge chains, or a lightweight
 * record-only endpoint for Base's direct-transfer path.
 */
async function registerEvmTransfer(
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const attempts = 3;
  const delaysMs = [1000, 3000];
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return;
    } catch {
      // network error -- fall through to retry/backoff below
    }
    if (i < delaysMs.length) {
      await new Promise((resolve) => setTimeout(resolve, delaysMs[i]));
    }
  }
  try {
    navigator.sendBeacon?.(endpoint, new Blob([JSON.stringify(payload)], { type: "application/json" }));
  } catch {
    // nothing more to do client-side
  }
}
```

- [x] **Step 5: Branch the submission flow by source chain (StellarampDashboard.tsx)**

In the function that currently builds `onInitiateOfframp` (today, Stellar-only), branch at the top on `tradeData.sourceChain` before any existing Stellar-specific code runs:

For `"stellar"`: completely unchanged — falls through to the existing code exactly as today.

For an `isCctpBridgeChain`-true EVM chain:
1. Call `useEvmWallet().switchChain(chainConfig.chainId)` and surface a clear "please switch to {label} in your wallet" error if it's rejected, **before** requesting a signature — matching the spec's explicit wrong-network handling.
2. `POST /api/offramp/bridge/evm-build-tx` (Task 4) with the resolved USDC amount and the order's Paycrest receive address.
3. `useEvmWallet().signAndSendCalls(calls, chainId)` (Task 8) on the returned calls in order (approve, if present, then the burn).
4. `registerEvmTransfer("/api/offramp/bridge/register-transfer", { burnTxHash, mintRecipient, amount, paycrestOrderId, sourceChain: chainConfig.key, connectedAddress })` (Step 4's helper, Task 7's route).

For `"base"`:
1. `POST /api/offramp/bridge/base-direct-tx` (Task 5).
2. `useEvmWallet().signAndSendCalls([call], chainId)`.
3. `registerEvmTransfer("/api/offramp/bridge/base-direct-register", { txHash, connectedAddress, amountUsdc: amount, destinationCurrency, destinationAmount, paycrestOrderId })` — the small registration route added in Task 6 Step 6 below.

- [x] **Step 6: Manual UI check**

Run: `npm run dev`, open the app, switch to OFF-RAMP, and confirm: the chain dropdown appears, only shows chains with `isChainEnabled(key)` true (should be empty/Stellar-only until Task 11's env var is set), and switching away from Stellar clears any connected Stellar wallet state.

- [x] **Step 7: Commit**

```bash
git add src/components/FormCard.tsx src/components/StellarampDashboard.tsx
git commit -m "feat(offramp): add source-chain dropdown, EVM wallet routing, and submission orchestration"
```

---

## Task 10: Gas estimate, chain-specific balance check, and fee display accuracy

**Files:**
- Modify: `src/app/api/offramp/bridge/evm-build-tx/route.ts` (add a gas estimate to the response)
- Modify: `src/components/FormCard.tsx` (surface the estimate + balance check, and stop assuming a near-zero bridge fee)

**Interfaces:**
- Consumes: viem's `publicClient.estimateGas`
- Produces: `evm-build-tx`'s response gains `estimatedGasNative: string` (in the chain's native token, human-readable) — the UI's pre-flight check and the "BRIDGE FEE" display both read it.

- [x] **Step 1: Add gas estimation to the build-tx route**

Inside the `withRetry` block in `src/app/api/offramp/bridge/evm-build-tx/route.ts` (Task 4), after `calls` is built, add:

```ts
      const lastCall = calls[calls.length - 1];
      const gasEstimate = await publicClient.estimateGas({
        account: fromAddress,
        to: lastCall.to,
        data: lastCall.data,
      });
      const gasPrice = await publicClient.getGasPrice();
      const estimatedGasNative = ((gasEstimate * gasPrice * BigInt(120)) / BigInt(100) / BigInt(10) ** BigInt(18)).toString();
      // +20% buffer -- an estimate, not a quote; the wallet's own gas price
      // at signing time is authoritative, this is only for the pre-flight
      // "do you have enough" check and display.

      return { calls, chainId: chainConfig.chainId, estimatedGasNative };
```

- [x] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors.

- [x] **Step 3: Surface it in FormCard.tsx**

In the amount-input section (Task 9), when an EVM chain is selected: fetch the native token balance via a lightweight `eth_getBalance` call (through the existing `useEvmWallet`'s connected client, or a small new read-only route mirroring the pattern of `evm-build-tx`), and block "INITIATE OFFRAMP" with a clear message ("Insufficient ETH for gas — you have X, need ~Y") when the balance is below `estimatedGasNative`, mirroring the existing Stellar XLM-reserve check's shape exactly.

- [x] **Step 4: Remove the "assume near-zero" bridge-fee framing**

Confirm the existing `getBurnFeeQuote`/`computeAtomicFee` path (already generalized in `evm-build-tx`) is what drives the "BRIDGE FEE" display for EVM sources too — no code change needed here since that machinery already handles arbitrary bps, but manually verify against a live quote for at least one non-Stellar pair:

```bash
curl -sS "https://iris-api.circle.com/v2/burn/USDC/fees/3/6"
```

Expected: a real `minimumFee` value (Arbitrum→Base, domains 3→6) — confirm it's non-zero (or note if it happens to also be 0 right now) so the UI's fee line is known to render correctly either way before shipping.

- [x] **Step 5: Commit**

```bash
git add src/app/api/offramp/bridge/evm-build-tx/route.ts src/components/FormCard.tsx
git commit -m "feat(offramp): add EVM gas estimation and chain-specific balance pre-flight check"
```

---

## Task 11: Rollout gate and staged live verification

**Files:**
- No new files — this task is about configuration and manual verification, not code.

> **Env var note:** during implementation `EVM_SOURCE_CHAINS_ENABLED` was renamed
> to **`NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED`** — the client dropdown needs to
> read it, and a non-public var is `undefined` in the browser. It is `NEXT_PUBLIC_`
> and therefore **build-time**: changing it needs a redeploy, not just a restart.
> The server routes (`evm-build-tx`, `base-direct-tx`, `evm-gas-preflight`,
> `evm-balances`) read the same var and 400 a disabled chain.

- [ ] **Step 1: Enable exactly one chain in production config**

Set `NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED=arbitrum` (only) in the deployment's environment variables, alongside `ARBITRUM_RPC_URL`.

- [x] **Step 2: Perform one real, small-amount end-to-end offramp from Arbitrum**

Using a real wallet with a small amount of real USDC on Arbitrum (e.g. $1-2): connect via the new dropdown, submit an offramp order, confirm: the approve+burn transaction confirms on Arbitrum, the attestation resolves, the mint lands on Base at Paycrest's receive address, Paycrest settles to a real bank account, and the transaction-history record (Task 6) shows `status: "completed"` with the correct `sourceChain`, `burnTxHash`, and `mintTxHash`.

**Verified 2026-09-09 (local dev against mainnet Arbitrum + live Circle Iris +
live Paycrest).** A real small-amount offramp from Arbitrum completed the full
path end to end: MetaMask (browser extension, EIP-6963) connected → approve +
`depositForBurn` signed on Arbitrum → Circle attestation resolved → mint landed
on Base at Paycrest's receive address → **Paycrest settled real fiat to a real
bank account.** BRIDGE FEE line showed the real Arbitrum→Base CCTP fee (~1.4 bps,
non-zero). Connection also confirmed working via WalletConnect QR (mobile) as an
alternative transport.

**Base direct-transfer path also verified 2026-09-09** (local dev vs mainnet):
a real small-amount offramp from Base completed end to end — single `transfer()`
signature (no approve, no CCTP), `base-direct-register` recorded it, Paycrest
settled real fiat. Progress stepper correctly showed "Submitting on Base". This
was the one genuinely-different code path; both it and the CCTP-bridge path
(Arbitrum) are now proven.

Not yet verified: Optimism / Avalanche / Polygon / Ethereum (config-only
difference from Arbitrum — same CCTP-bridge code). Production env not yet
switched on — tested locally only; `dev` branch commits not yet pushed.

- [ ] **Step 3: Only after Step 2 succeeds, enable the remaining chains**

Update `NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED=arbitrum,optimism,avalanche,polygon,ethereum,base` (add `ETHEREUM_RPC_URL`, `OPTIMISM_RPC_URL`, `AVALANCHE_RPC_URL`, `POLYGON_RPC_URL` at the same time). Since these chains share identical code paths with Arbitrum (only config differs), a full separate live transaction per chain is lower-priority than Step 2 was, but still worth at least one real small-amount check per chain before considering the feature fully shipped — particularly Base, since its direct-transfer path is genuinely different code from the CCTP-bridge chains.

- [ ] **Step 4: Record the outcome**

Note in this plan file (or a follow-up commit message) which chains were live-verified and on what date, mirroring how the original CCTP integration's testnet/mainnet verification was tracked.
