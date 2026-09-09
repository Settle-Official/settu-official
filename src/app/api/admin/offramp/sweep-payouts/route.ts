import { NextRequest, NextResponse } from "next/server";
import { listNonTerminalPayoutOrderIds } from "@/lib/offramp/payout-store";
import { reconcilePayoutOrder } from "@/lib/offramp/settlement";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Reconciles every non-terminal payout record against Paycrest's live status.
 * One-off recovery for orders stranded before the order-status poll route
 * learned to surface `fulfilled` (Paycrest sends no webhook for it), so a
 * completed offramp could sit "processing" forever.
 *
 * Safe to run repeatedly — reconcilePayoutOrder is rank-guarded and the
 * settlement recording is claimed atomically. Auth:
 * `Authorization: Bearer $ADMIN_API_SECRET` (required in production).
 */
export async function POST(request: NextRequest) {
  const secret = process.env.ADMIN_API_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const ids = await listNonTerminalPayoutOrderIds();
  const results: { orderId: string; status?: string; error?: string }[] = [];

  for (const orderId of ids) {
    try {
      const status = await reconcilePayoutOrder(orderId);
      results.push({ orderId, status });
    } catch (err: any) {
      results.push({ orderId, error: err?.message || "reconcile failed" });
    }
  }

  const advanced = results.filter(
    (r) => r.status === "validated" || r.status === "fulfilled" || r.status === "settled",
  ).length;

  return NextResponse.json({
    scanned: ids.length,
    advancedToComplete: advanced,
    results,
  });
}
