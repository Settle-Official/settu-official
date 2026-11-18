import type { BridgeChainKey } from "./chains";

/**
 * Sources Circle runs Fast Transfer from (Circle's raw docs, 2026-11-17:
 * developers.circle.com/cctp/concepts/finality-and-block-confirmations.md,
 * the Fast table lists Ethereum, Arbitrum, Base, OP Mainnet and Solana).
 *
 * From Stellar, Avalanche and Polygon, Circle attests at Standard however the
 * burn is sent, and Standard already lands in seconds there. Offering Fast
 * would only charge the Fast fee for a Standard delivery (seen on testnet
 * 2026-11-18: every Fast bridge from Stellar fell back to Standard).
 */
const FAST_SOURCES = new Set<BridgeChainKey>(["ethereum", "base", "arbitrum", "optimism", "solana"]);

export function offersFast(source: BridgeChainKey): boolean {
  return FAST_SOURCES.has(source);
}
