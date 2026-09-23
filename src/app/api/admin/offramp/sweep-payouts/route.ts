import { NextRequest, NextResponse } from "next/server";
import { listNonTerminalPayoutOrderIds } from "@/lib/offramp/payout-store";
import { reconcilePayoutOrder } from "@/lib/offramp/settlement";
import { requireAdmin, recordOutcome } from "@/lib/admin/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Reconciles every non-terminal payout record against Paycrest's live status.
 * One-off recovery for orders stranded before the order-status poll route
 * learned to surface `fulfilled` (Paycrest sends no webhook for it), so a
 * completed offramp could sit "processing" forever.
 *
 * Safe to run repeatedly — reconcilePayoutOrder is rank-guarded and the
 * settlement recording is claimed atomically.
 *
 * Auth: a signed-in admin account. Log in, then send the session token as
 * `Authorization: Bearer <token>`.
 */
export async function POST(request: NextRequest) {
  let audit;
  try {
    audit = await requireAdmin(request, "offramp.sweep_payouts");
  } catch {
    // Fails closed: unset config, an unreachable API and a non-admin caller
    // all land here, and none is a reason to run an admin action.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
