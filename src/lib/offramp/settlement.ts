/**
 * Records a confirmed offramp payout (Paycrest reached `validated` or
 * `fulfilled` — the recipient's fiat is delivered) in the live transactions
 * feed + platform volume. Exactly once per order, enforced by
 * `claimSettlementRecording` (Redis SET NX), so it's safe to call from both
 * the Paycrest webhook and the order-status poll route (which surfaces
 * `fulfilled` — Paycrest sends no webhook for that state).
 */
import {
  claimSettlementRecording,
  getPayoutStatus,
  setPayoutStatus,
  isTerminal,
} from "./payout-store";
import { getOrderMeta } from "./order-meta-store";
import {
  PaycrestAdapter,
  normalizePayoutStatus,
} from "./adapters/paycrest-adapter";
import type { PayoutStatus } from "./types";
import { pushRecentTransaction, addVolume } from "@/lib/stats-store";
import { formatFiat } from "@/lib/format/currency";

export async function recordOfframpPayoutConfirmed(
  orderId: string,
  opts: { txHash?: string } = {},
): Promise<void> {
  if (!(await claimSettlementRecording(orderId))) return;

  const meta = await getOrderMeta(orderId);
  const usdc = meta?.amountUsdc;
  if (usdc === undefined || !Number.isFinite(usdc)) return;

  const displayHash = opts.txHash || orderId;
  void pushRecentTransaction({
    txHash: `${displayHash.slice(0, 4)}...${displayHash.slice(-4)}`,
    usdc: usdc.toFixed(2),
    naira: formatFiat(meta?.payoutValue, meta?.currency),
    status: "COMPLETE",
    type: "offramp",
  });
  void addVolume(usdc);
}

/**
 * Pulls an order's LIVE status from Paycrest and reconciles it into the
 * payout store (rank-guarded, so it can't regress), recording the settlement
 * if it just reached validated/fulfilled. Used by the order-status poll route
 * (per-order, on demand) and the stuck-order sweep. No-ops on a terminal
 * cached status. Returns the status now in effect.
 */
export async function reconcilePayoutOrder(
  orderId: string,
): Promise<PayoutStatus> {
  const cached = await getPayoutStatus(orderId);
  if (cached && isTerminal(cached.status)) return cached.status;

  const apiKey = process.env.PAYCREST_API_KEY;
  if (!apiKey) return cached?.status ?? "unknown";

  const paycrest = new PaycrestAdapter(apiKey);
  const live = await paycrest.getOrderStatusV2(orderId);
  const merged = await setPayoutStatus(orderId, {
    status: normalizePayoutStatus(live?.status),
    event: "api-poll",
  });
  console.log(
    `[payout-reconcile] ${orderId}: live="${live?.status}" -> ${merged.status}`,
  );

  if (merged.status === "validated" || merged.status === "fulfilled") {
    await recordOfframpPayoutConfirmed(orderId, { txHash: merged.txHash });
  }
  return merged.status;
}
