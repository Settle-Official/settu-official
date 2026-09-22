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
import { updateTransactionByOrderId } from "./transaction-history";

export async function recordOfframpPayoutConfirmed(
  orderId: string,
  opts: { txHash?: string } = {},
): Promise<void> {
  const meta = await getOrderMeta(orderId);
  // Ahead of the claim guard on purpose. The guard exists to make the stats
  // push happen exactly once, but this is a state reconciliation, not a
  // counter — it must still run on the poll path when the webhook already
  // took the claim, and it is safe to repeat (same terminal value, and
  // updateTransactionByOrderId refuses to regress a completed record).
  // Without this, an offramp that finishes at `fulfilled` — which Paycrest
  // never sends a webhook for — would sit at "pending" in history forever.
  void updateTransactionByOrderId(orderId, "completed", {
    ...(meta?.payoutValue !== undefined
      ? { destinationAmount: String(meta.payoutValue) }
      : {}),
    ...(opts.txHash ? { mintTxHash: opts.txHash } : {}),
  });

  if (!(await claimSettlementRecording(orderId))) return;

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
  if (cached && isTerminal(cached.status)) {
    // Don't re-poll Paycrest for an order that's already finished — but do
    // still reconcile, because the permanent transaction record is written
    // at burn time and only this path brings it to a terminal state. The old
    // bare `return` skipped that, so any order whose payout was already
    // cached as terminal kept a "pending" record forever: the user saw a
    // stuck transfer in History and got no completion notification, even
    // though the money had landed. recordOfframpPayoutConfirmed is
    // idempotent (the stats push is claimed once via Redis SET NX), so
    // running it again here is safe.
    if (cached.status === "settled") {
      await recordOfframpPayoutConfirmed(orderId, { txHash: cached.txHash });
    }
    return cached.status;
  }

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
