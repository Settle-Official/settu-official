/**
 * On-demand status check for an onramp order — the handler behind the
 * "Check status" Telegram button. If the order is `bridging`, actively
 * re-checks its bridge right now instead of waiting for the once-daily cron
 * or an open SSE tab.
 *
 * Orders bridged via CCTP (the current default — carry a `cctpTransferId`)
 * are advanced via advanceCctpTransfer, same logic the onramp SSE stream
 * uses. Orders that predate the CCTP cutover (no `cctpTransferId`) fall back
 * to the legacy Allbridge finalizer so in-flight pre-cutover orders still
 * resolve correctly.
 *
 * If the order is `bridge_failed`, this actually retries it instead of just
 * re-reporting the frozen failureReason from whenever it originally failed —
 * otherwise tapping "Check status" after fixing the underlying issue (e.g.
 * funding hot-wallet gas) would forever echo the same stale error. Which
 * retry is correct depends on whether a burn already confirmed: with a
 * cctpTransferId on the order, it did (that field is only ever set after
 * one lands on-chain — see handleOnrampSettled), so this resumes the
 * existing transfer (reviveStuckTransfer) rather than submitting a second
 * burn (retryOnrampBridge) for the same settled USDC.
 */

import { getOnrampOrder, updateOnrampOrder } from "./onramp-store";
import { markOnrampDelivered } from "./mark-delivered";
import { finalizeOnrampOrder } from "./finalize";
import { retryOnrampBridge } from "./retry-bridge";
import { initializeAllbridgeSdk } from "@/lib/offramp/adapters/allbridge-adapter";
import { getCctpTransfer } from "@/lib/cctp/cctp-store";
import { advanceCctpTransfer } from "@/lib/cctp/advance";
import { reviveStuckTransfer } from "@/lib/cctp/revive";
import { alertManualAction } from "@/lib/notify/telegram";

export interface StatusCheckResult {
  message: string;
  level: "info" | "success" | "warning";
  /**
   * True when finalizeOnrampOrder already posted a full delivered/failed
   * alert as a side effect of this check — the caller should only toast
   * `message`, not post it again as a second chat message.
   */
  alreadyAlerted?: boolean;
}

export async function checkOnrampStatus(
  orderId: string,
): Promise<StatusCheckResult> {
  const record = await getOnrampOrder(orderId);
  if (!record) {
    return { message: `Order ${orderId} not found.`, level: "warning" };
  }

  if (record.status === "bridging" && record.cctpTransferId) {
    const cctpStatus = await advanceCctpTransfer(record.cctpTransferId);
    if (cctpStatus === "completed") {
      const transfer = await getCctpTransfer(record.cctpTransferId);
      await markOnrampDelivered(orderId, {
        stellarTxHash: transfer?.mintTxHash,
      });
      // markOnrampDelivered already posted the delivery alert.
      return { message: "Delivered ✓", level: "success", alreadyAlerted: true };
    }
    if (cctpStatus === "failed") {
      await updateOnrampOrder(orderId, {
        status: "bridge_failed",
        failureReason: "CCTP transfer failed after max retries",
      });
      // The burn already confirmed on-chain (that's the only way this
      // CctpTransferRecord exists) — this is specifically a stuck
      // attest/mint. Alert directly (rather than letting the caller's
      // generic notify fire) so the revive button actually gets attached.
      await alertManualAction({
        title: "Onramp bridge stuck after burn — mint never completed",
        orderId,
        amount: record.baseUsdcAmount,
        currency: "USDC",
        stellarAddress: record.userStellarAddress,
        reason:
          "CCTP transfer exhausted its retry budget after burning — safe to revive, don't retry-burn.",
        cctpTransferId: record.cctpTransferId,
      });
      return {
        message: "Failed — CCTP transfer exhausted retries",
        level: "warning",
        alreadyAlerted: true,
      };
    }
    return {
      message: `Order ${orderId} is still bridging (CCTP status: ${cctpStatus}).`,
      level: "info",
    };
  }

  if (record.status === "bridging") {
    // Legacy pre-cutover order — no cctpTransferId, was bridged via Allbridge.
    const sdk = await initializeAllbridgeSdk();
    const outcome = await finalizeOnrampOrder(sdk, orderId);
    if (outcome === "delivered" || outcome === "failed") {
      // finalizeOnrampOrder already sent the full delivered/failed alert.
      return {
        message: outcome === "delivered" ? "Delivered ✓" : "Failed — see alert",
        level: outcome === "delivered" ? "success" : "warning",
        alreadyAlerted: true,
      };
    }
    return {
      message: `Order ${orderId} is still bridging — not yet confirmed on Stellar.`,
      level: "info",
    };
  }

  if (record.status === "bridge_failed") {
    if (record.cctpTransferId) {
      // A burn already confirmed and got a transfer record — resume it,
      // never submit a second burn for the same settled USDC. Doesn't send
      // its own alert, so the caller's generic notify(result.message) is
      // the only message (no alreadyAlerted).
      const result = await reviveStuckTransfer(record.cctpTransferId, orderId);
      return { message: result.message, level: result.ok ? "success" : "warning" };
    }
    // No confirmed burn on record — safe to submit a fresh one.
    // handleOnrampSettled (called inside retryOnrampBridge) already sends
    // its own success/failure alert, so this is always toast-only.
    const result = await retryOnrampBridge(orderId);
    return { message: result.message, level: result.ok ? "success" : "warning", alreadyAlerted: true };
  }

  const suffix = record.stellarTxHash ? ` (tx ${record.stellarTxHash})` : "";
  const reason = record.failureReason ? ` — ${record.failureReason}` : "";
  return {
    message: `Order ${orderId} status: ${record.status}${suffix}${reason}`,
    level: record.status === "delivered" ? "success" : "info",
  };
}
