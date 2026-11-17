/**
 * Registry of the 8 chains the user bridge moves USDC between over CCTP V2.
 * Mainnet/testnet values switch on CCTP_NETWORK, as constants.ts does.
 *
 * Mainnet addresses are imported from the existing per-chain modules, not
 * duplicated. The testnet EVM USDC addresses below were copied verbatim from
 * Circle's raw docs (curl, not summarized) on 2026-11-17:
 *   https://developers.circle.com/stablecoins/usdc-contract-addresses.md
 */

import { CCTP_CONFIG, CCTP_DOMAIN, CCTP_NETWORK } from "../cctp/constants";
import { EVM_SOURCE_CHAINS } from "../cctp/evm-chains";
import { SOLANA_CONFIG } from "../solana/config";

export type BridgeChainKey =
  | "stellar"
  | "ethereum"
  | "base"
  | "arbitrum"
  | "optimism"
  | "avalanche"
  | "polygon"
  | "solana";

export type ChainFamily = "evm" | "stellar" | "solana";

export interface BridgeChain {
  key: BridgeChainKey;
  label: string;
  family: ChainFamily;
  cctpDomain: number;
  usdcDecimals: 6 | 7;
  /** USDC address (EVM), Soroban contract ID (Stellar) or mint (Solana). */
  usdc: string;
  chainId?: number;
  rpcEnvVar: string;
  nativeSymbol: string;
  explorerTx(hash: string): string;
}

const TESTNET = CCTP_NETWORK === "testnet";

type EvmKey = Exclude<BridgeChainKey, "stellar" | "solana">;

interface EvmTestnet {
  chainId: number;
  usdc: string;
  explorer: string;
}

const EVM_TESTNET: Record<EvmKey, EvmTestnet> = {
  ethereum: {
    chainId: 11155111, // Ethereum Sepolia
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    explorer: "https://sepolia.etherscan.io",
  },
  base: {
    chainId: 84532, // Base Sepolia
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorer: "https://sepolia.basescan.org",
  },
  arbitrum: {
    chainId: 421614, // Arbitrum Sepolia
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
    explorer: "https://sepolia.arbiscan.io",
  },
  optimism: {
    chainId: 11155420, // OP Sepolia
    usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7",
    explorer: "https://sepolia-optimism.etherscan.io",
  },
  avalanche: {
    chainId: 43113, // Avalanche Fuji
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    explorer: "https://testnet.snowtrace.io",
  },
  polygon: {
    chainId: 80002, // Polygon PoS Amoy
    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    explorer: "https://amoy.polygonscan.com",
  },
};

const EVM_MAINNET_EXPLORER: Record<EvmKey, string> = {
  ethereum: "https://etherscan.io",
  base: "https://basescan.org",
  arbitrum: "https://arbiscan.io",
  optimism: "https://optimistic.etherscan.io",
  avalanche: "https://snowtrace.io",
  polygon: "https://polygonscan.com",
};

function evmChain(key: EvmKey): BridgeChain {
  const src = EVM_SOURCE_CHAINS[key];
  const test = EVM_TESTNET[key];
  const explorer = TESTNET ? test.explorer : EVM_MAINNET_EXPLORER[key];
  return {
    key,
    label: src.label,
    family: "evm",
    cctpDomain: CCTP_DOMAIN[key],
    usdcDecimals: 6,
    usdc: TESTNET ? test.usdc : src.usdcAddress,
    chainId: TESTNET ? test.chainId : src.chainId,
    rpcEnvVar: src.rpcUrlEnvVar,
    nativeSymbol: src.nativeCurrencySymbol,
    explorerTx: (hash) => `${explorer}/tx/${hash}`,
  };
}

export const BRIDGE_CHAINS: Record<BridgeChainKey, BridgeChain> = {
  stellar: {
    key: "stellar",
    label: "Stellar",
    family: "stellar",
    cctpDomain: CCTP_DOMAIN.stellar,
    usdcDecimals: 7,
    usdc: CCTP_CONFIG.stellarUsdc,
    rpcEnvVar: "STELLAR_SOROBAN_RPC_URL",
    nativeSymbol: "XLM",
    explorerTx: (hash) =>
      `https://stellar.expert/explorer/${TESTNET ? "testnet" : "public"}/tx/${hash}`,
  },
  ethereum: evmChain("ethereum"),
  base: evmChain("base"),
  arbitrum: evmChain("arbitrum"),
  optimism: evmChain("optimism"),
  avalanche: evmChain("avalanche"),
  polygon: evmChain("polygon"),
  solana: {
    key: "solana",
    label: "Solana",
    family: "solana",
    cctpDomain: CCTP_DOMAIN.solana,
    usdcDecimals: 6,
    usdc: SOLANA_CONFIG.usdcMint,
    rpcEnvVar: "SOLANA_RPC_URL",
    nativeSymbol: "SOL",
    explorerTx: (hash) =>
      `https://explorer.solana.com/tx/${hash}${TESTNET ? "?cluster=devnet" : ""}`,
  },
};

export function bridgeChainByDomain(domain: number): BridgeChain {
  const chain = Object.values(BRIDGE_CHAINS).find(
    (c) => c.cctpDomain === domain,
  );
  if (!chain) throw new Error(`Unknown CCTP domain: ${domain}`);
  return chain;
}

/** UI order; the `{ code, name }` shape AppSelect expects. */
export const BRIDGE_CHAIN_OPTIONS: { code: BridgeChainKey; name: string }[] = (
  [
    "solana",
    "base",
    "stellar",
    "ethereum",
    "arbitrum",
    "optimism",
    "avalanche",
    "polygon",
  ] as const
).map((code) => ({ code, name: BRIDGE_CHAINS[code].label }));
