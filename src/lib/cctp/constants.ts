/**
 * All addresses below were pulled directly from Circle's raw CCTP docs
 * (developers.circle.com/cctp/references/contract-addresses,
 * developers.circle.com/cctp/references/stellar-contracts,
 * developers.circle.com/stablecoins/usdc-contract-addresses) on 2026-08-20 —
 * not AI-summarized, hex/strkey addresses copied verbatim. The mainnet Stellar
 * USDC contract ID was cross-verified two ways: derived independently via
 * `Asset.contractId()` from the classic USDC asset, and matches the "CCW67..."
 * prefix already referenced in this codebase's existing
 * `soroban-tx-builder.ts` docstring for the (unrelated) Allbridge integration.
 */

export type CctpNetwork = "mainnet" | "testnet";

// The browser only sees NEXT_PUBLIC_* variables (inlined at build), so
// client code (the bridge's chain registry: USDC addresses, explorers) reads
// NEXT_PUBLIC_CCTP_NETWORK. Set both together; unset means mainnet.
export const CCTP_NETWORK: CctpNetwork =
  (process.env.CCTP_NETWORK ?? process.env.NEXT_PUBLIC_CCTP_NETWORK) === "testnet"
    ? "testnet"
    : "mainnet";

// Domain identifiers are protocol-wide constants, same on mainnet and testnet.
export const CCTP_DOMAIN = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  solana: 5,
  base: 6,
  polygon: 7,
  stellar: 27,
} as const;

// Fast Transfer vs Standard Transfer, per MessageTransmitterV2#sendMessage docs.
export const FINALITY_THRESHOLD = {
  fast: 1000,
  standard: 2000,
} as const;

export const STELLAR_USDC_DECIMALS = 7;
export const BASE_USDC_DECIMALS = 6;

/**
 * MessageTransmitterV2 — one address per network, shared by every EVM chain
 * the bridge uses (Ethereum, Avalanche, OP, Arbitrum, Base, Polygon). Copied
 * verbatim from Circle's raw docs on 2026-11-17 (curl, not summarized):
 *   https://developers.circle.com/cctp/references/contract-addresses.md
 * The testnet value previously used for Base (0x8745D906…) is Circle's
 * testnet *TokenMessengerWithFees*, not the transmitter.
 */
export const EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK = {
  mainnet: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  testnet: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
} as const satisfies Record<CctpNetwork, `0x${string}`>;

export const EVM_MESSAGE_TRANSMITTER_V2: `0x${string}` =
  EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK[CCTP_NETWORK];

export interface CctpAddresses {
  stellarTokenMessengerMinter: string;
  stellarMessageTransmitter: string;
  stellarCctpForwarder: string;
  stellarUsdc: string;
  stellarRpcUrl: string;
  stellarNetworkPassphrase: string;
  baseTokenMessengerV2: `0x${string}`;
  baseMessageTransmitterV2: `0x${string}`;
  baseUsdc: `0x${string}`;
  irisApiUrl: string;
}

const MAINNET: CctpAddresses = {
  stellarTokenMessengerMinter:
    "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
  stellarMessageTransmitter:
    "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
  stellarCctpForwarder:
    "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
  stellarUsdc: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  stellarRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL ||
    "https://soroban-rpc.mainnet.stellar.gateway.fm",
  stellarNetworkPassphrase: "Public Global Stellar Network ; September 2015",
  baseTokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
  baseMessageTransmitterV2: EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK.mainnet,
  baseUsdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  irisApiUrl: process.env.CCTP_IRIS_API_URL || "https://iris-api.circle.com",
};

const TESTNET: CctpAddresses = {
  stellarTokenMessengerMinter:
    "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
  stellarMessageTransmitter:
    "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
  stellarCctpForwarder:
    "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  stellarUsdc: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  stellarRpcUrl:
    process.env.STELLAR_SOROBAN_RPC_URL_TESTNET ||
    "https://soroban-testnet.stellar.org",
  stellarNetworkPassphrase: "Test SDF Network ; September 2015",
  baseTokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  baseMessageTransmitterV2: EVM_MESSAGE_TRANSMITTER_V2_BY_NETWORK.testnet,
  baseUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  irisApiUrl:
    process.env.CCTP_IRIS_API_URL_TESTNET ||
    "https://iris-api-sandbox.circle.com",
};

export const CCTP_CONFIGS: Record<CctpNetwork, CctpAddresses> = {
  mainnet: MAINNET,
  testnet: TESTNET,
};

export const CCTP_CONFIG: CctpAddresses =
  CCTP_NETWORK === "testnet" ? TESTNET : MAINNET;
