import { NextRequest, NextResponse } from "next/server";
import { getPayoutStatus, isTerminal } from "@/lib/offramp/payout-store";
import { reconcilePayoutOrder } from "@/lib/offramp/settlement";
import { recoverOrder } from "@/lib/offramp/burn-backstop";
import { claimPollRecovery } from "@/lib/offramp/poll-recovery";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await params;
    const cached = await getPayoutStatus(orderId);

    // A terminal cached status is authoritative — no Paycrest call needed.
    if (cached && isTerminal(cached.status)) {
      return NextResponse.json({
        data: { id: orderId, status: cached.status },
        source: "cache",
      });
    }

    // Non-terminal or missing: reconcile against Paycrest's LIVE status.
    // Paycrest surfaces `fulfilled` (bank credited) only through the API — it
    // sends no webhook for it — so a webhook-only view stalls a completed
    // offramp forever. This self-heals: the live status is written back to the
    // payout store (so the SSE stream + next poll see it) and the settlement
    // is recorded once it's confirmed.
    try {
      const status = await reconcilePayoutOrder(orderId);

      // The user is sitting on this page watching a transfer that hasn't
      // finished. If their burn landed on-chain but its registration was
      // lost, nothing will ever mint it — and waiting for the 03:17 sweep
      // to notice is not an acceptable answer for someone's money. Their
      // own poll is the earliest moment we can know, so recover here.
      //
      // Rate-limited per order (see claimPollRecovery): the on-chain lookup
      // costs a Horizon/RPC call plus Iris, and a poll runs every few
      // seconds. Fire-and-forget so a slow chain never delays the response
      // the page is waiting on.
      if (!isTerminal(status) && (await claimPollRecovery(orderId))) {
        void recoverOrder(orderId).catch((err) =>
          console.error(`[poll-recovery] ${orderId} failed:`, err),
        );
      }

      return NextResponse.json({
        data: { id: orderId, status },
        source: "api",
      });
    } catch (apiErr: any) {
      // Paycrest unreachable — serve the cache rather than erroring the poller.
      if (cached) {
        return NextResponse.json({
          data: { id: orderId, status: cached.status },
          source: "cache-fallback",
        });
      }
      throw apiErr;
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to fetch Paycrest order status" },
      { status: 500 },
    );
  }
}
