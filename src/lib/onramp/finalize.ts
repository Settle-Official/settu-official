/**
 * Finalizes an in-flight Base→Stellar onramp bridge: checks the Allbridge
 * transfer and moves the order to `delivered` / `bridge_failed`, cleaning up the
 * pending-bridge set and firing the appropriate alert.
 *
 * Shared by two callers:
 *   - the Vercel cron (`/api/cron/finalize-onramp`) — backstop for closed tabs
 *   - the onramp SSE stream — fast path while the user's tab is open
 *
 * On Vercel Hobby, cron only fires once per day, so the SSE path is what gives
 * timely confirmation. Both are idempotent and safe to run concurrently: the
 * store's no-regress + terminal-freeze semantics mean a double-finalize is a
 * no-op.
 */

import {
  getOnrampOrder,
  updateOnrampOrder,
  removePendingBridge,
  type OnrampRecord,
} from "./onramp-store";
import { getAllbridgeTransferStatus } from "@/lib/offramp/adapters/allbridge-adapter";
import { alertManualAction } from "@/lib/notify/telegram";
import { markOnrampDelivered } from "./mark-delivered";

// If a bridge hasn't confirmed within this window, escalate once for manual
// review (funds may be stuck) but keep watching.
const STALE_MS = 30 * 60 * 1000; // 30 min

export type FinalizeOutcome =
  | "delivered"
  | "failed"
  | "pending"
  | "not-bridging";

/**
 * Check one order's bridge and advance its state. `sdk` is the initialized
 * Allbridge SDK (caller owns its lifecycle so a batch can share one instance).
 */
export async function finalizeOnrampOrder(
  sdk: any,
  orderId: string,
): Promise<FinalizeOutcome> {
  const record: OnrampRecord | null = await getOnrampOrder(orderId);

  // Order gone or no longer bridging — stop watching it.
  if (!record || record.status !== "bridging" || !record.bridgeTxHash) {
    await removePendingBridge(orderId);
    return "not-bridging";
  }

  // Source chain for this leg is Base ("BAS").
  const transfer = await getAllbridgeTransferStatus(
    sdk,
    "BAS",
    record.bridgeTxHash,
  );

  if (transfer.status === "completed") {
    await markOnrampDelivered(orderId, {
      stellarTxHash: transfer.txHash,
      deliveredUsdc: transfer.receiveAmount ?? record.baseUsdcAmount,
    });
    return "delivered";
  }

  if (transfer.status === "failed") {
    // Bridge reported failure — hold and escalate; do not auto-retry.
    await updateOnrampOrder(orderId, {
      status: "bridge_failed",
      failureReason: "Allbridge reported transfer failed",
    });
    await removePendingBridge(orderId);
    await alertManualAction({
      title: "Onramp bridge failed on-chain",
      orderId,
      amount: record.baseUsdcAmount,
      currency: "USDC",
      stellarAddress: record.userStellarAddress,
      reason: `Allbridge transfer ${record.bridgeTxHash} failed.`,
    });
    return "failed";
  }

  // Still in flight. Escalate once if it's been stuck too long, but keep
  // watching (leave it in the pending set).
  const startedAt = record.bridgeStartedAt ?? record.updatedAt;
  if (Date.now() - startedAt > STALE_MS && !record.staleAlerted) {
    await updateOnrampOrder(orderId, { staleAlerted: true });
    void alertManualAction({
      title: "Onramp bridge slow to confirm",
      orderId,
      amount: record.baseUsdcAmount,
      currency: "USDC",
      stellarAddress: record.userStellarAddress,
      reason:
        `Bridge ${record.bridgeTxHash} still not confirmed after ` +
        `${Math.round((Date.now() - startedAt) / 60000)} min.`,
    });
  }

  return "pending";
}
