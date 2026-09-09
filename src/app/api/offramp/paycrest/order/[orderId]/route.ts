import { NextRequest, NextResponse } from "next/server";
import { getPayoutStatus, isTerminal } from "@/lib/offramp/payout-store";
import { reconcilePayoutOrder } from "@/lib/offramp/settlement";

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
