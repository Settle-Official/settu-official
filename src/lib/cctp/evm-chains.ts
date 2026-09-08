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
 *
 * Addresses below were copied verbatim from Circle's raw docs (fetched via
 * curl, not AI-summarized) on 2026-09-08:
 *   developers.circle.com/stablecoins/usdc-contract-addresses  (USDC)
 *   developers.circle.com/cctp/evm-smart-contracts             (TokenMessengerV2, domains)
 * — native Circle-issued USDC, not bridged/legacy variants. Before merging,
 * independently cross-check each USDC address against that chain's own block
 * explorer (Etherscan/Arbiscan/etc. contract page) — the same two-source
 * standard constants.ts's Stellar/Base addresses were held to.
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
// verified against Circle's contract-addresses docs (2026-09-08), identical
// across Ethereum/Avalanche/OP Mainnet/Arbitrum/Base/Polygon PoS. Matches
// CCTP_CONFIG.baseTokenMessengerV2 in constants.ts. Kept as one shared
// constant rather than repeated per chain entry, since a real difference
// would mean a genuinely new deployment, not per-chain config.
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
