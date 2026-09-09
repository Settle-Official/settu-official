/**
 * Solana CCTP V2 source-chain config for offramp (burn USDC on Solana ->
 * mint on Base -> Paycrest payout). Parallel to `cctp/constants.ts` (Stellar
 * + Base) and `cctp/evm-chains.ts` (the six EVM sources); Solana is neither,
 * so it gets its own module.
 *
 * Addresses copied verbatim from Circle's raw docs (fetched 2026-09-09):
 *   developers.circle.com/cctp/solana-programs         (program IDs, domain 5)
 *   developers.circle.com/stablecoins/usdc-contract-addresses  (USDC mints)
 * The two program IDs were cross-checked against the `address` field of the
 * vendored on-chain IDLs in ./idl/ (a test asserts they stay in sync), and
 * the devnet USDC mint was confirmed by a real devnet `deposit_for_burn`
 * (see the Solana offramp plan, Task 1). Before mainnet launch, re-verify
 * each against Solscan / Solana Explorer's program pages — the same
 * two-source standard as constants.ts / evm-chains.ts.
 */

// Same program IDs on mainnet and devnet (per Circle's docs).
const MESSAGE_TRANSMITTER_V2 = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";
const TOKEN_MESSENGER_MINTER_V2 = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** Protocol-wide, same on mainnet and devnet. */
export const SOLANA_CCTP_DOMAIN = 5 as const;

/** USDC has 6 decimals on Solana (same as EVM). */
export const SOLANA_USDC_DECIMALS = 6 as const;

// Reuse the existing CCTP_NETWORK switch so Solana follows the same
// mainnet/testnet toggle as the rest of the bridge.
const IS_TESTNET = process.env.CCTP_NETWORK === "testnet";

export interface SolanaConfig {
  messageTransmitterV2: string;
  tokenMessengerMinterV2: string;
  usdcMint: string;
  cctpDomain: typeof SOLANA_CCTP_DOMAIN;
  usdcDecimals: typeof SOLANA_USDC_DECIMALS;
  /** Server RPC — no public fallback (public endpoints rate-limit hard). */
  readonly rpcUrl: string | undefined;
}

export const SOLANA_CONFIG: SolanaConfig = {
  messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
  tokenMessengerMinterV2: TOKEN_MESSENGER_MINTER_V2,
  usdcMint: IS_TESTNET ? USDC_MINT_DEVNET : USDC_MINT_MAINNET,
  cctpDomain: SOLANA_CCTP_DOMAIN,
  usdcDecimals: SOLANA_USDC_DECIMALS,
  get rpcUrl() {
    return process.env.SOLANA_RPC_URL;
  },
};

/** Throws if the server RPC isn't configured — call from route handlers. */
export function requireSolanaRpcUrl(): string {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("SOLANA_RPC_URL not configured");
  return url;
}

/**
 * Rollout gate. `NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED` is the offramp-wide
 * allowlist (renamed from `…_EVM_SOURCE_CHAINS_ENABLED`; the old name is still
 * honoured for one release). Empty/unset ⇒ Solana is not selectable and the
 * server routes reject it.
 */
export function isSolanaEnabled(): boolean {
  const raw =
    process.env.NEXT_PUBLIC_OFFRAMP_SOURCE_CHAINS_ENABLED ??
    process.env.NEXT_PUBLIC_EVM_SOURCE_CHAINS_ENABLED ??
    "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes("solana");
}
