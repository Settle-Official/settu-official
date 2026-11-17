import type { BridgeChainKey } from "./chains";
import type { Speed } from "./quote-math";

/**
 * The estimated time shown on the speed switch and in the fee breakdown.
 *
 * Source-chain finality from Circle's raw docs, 2026-11-17
 * (developers.circle.com/cctp/concepts/finality-and-block-confirmations.md):
 * Fast ~8 s on Base/Arbitrum/OP and ~20 s on Ethereum; Standard ~15–19 min on
 * those four (they wait for Ethereum finality), ~8 s on Avalanche and Polygon,
 * ~17 s on Solana, ~5 s on Stellar. Rounded up to leave room for the
 * attestation and Settu's delivery on the destination.
 */
const ETH_FINALITY = new Set<BridgeChainKey>(["ethereum", "base", "arbitrum", "optimism"]);

export function estimatedTime(source: BridgeChainKey, speed: Speed): string {
  if (!ETH_FINALITY.has(source)) return "under a minute";
  if (speed === "standard") return "~15–20 min";
  return source === "ethereum" ? "~1 min" : "under a minute";
}
