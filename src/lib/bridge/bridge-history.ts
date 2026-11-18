/**
 * A completed bridge (bridge-ledger.ts) as a row in the app's History.
 * Completed is the only status: the ledger holds finished bridges only.
 */

import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import type { CompletedBridge } from "./bridge-ledger";

export interface BridgeHistoryRow {
  readonly id: string;
  readonly kind: "bridge";
  readonly usdc: number;
  readonly receivedUsdc: number;
  readonly currency: "USDC";
  readonly status: "completed";
  readonly timestamp: number;
  readonly sourceChain: string;
  readonly destChain: string;
  readonly txHash: string;
  readonly destTxHash?: string;
  readonly route: string;
  readonly source: "server";
}

const usdc = (atomic: string) => (/^\d+$/.test(atomic) ? Number(atomic) / 1_000_000 : 0);
const label = (c: string) => BRIDGE_CHAINS[c as BridgeChainKey]?.label ?? c;

export function bridgeHistoryRow(e: CompletedBridge): BridgeHistoryRow {
  return {
    id: e.id,
    kind: "bridge",
    usdc: usdc(e.sendAtomic),
    receivedUsdc: usdc(e.receivedAtomic),
    currency: "USDC",
    status: "completed",
    timestamp: e.completedAt,
    sourceChain: e.source,
    destChain: e.dest,
    txHash: e.sourceTx,
    ...(e.destTx ? { destTxHash: e.destTx } : {}),
    route: `${label(e.source)} → ${label(e.dest)}`,
    source: "server",
  };
}
