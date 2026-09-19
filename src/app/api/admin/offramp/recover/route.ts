import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { recordAdminAction } from "@/lib/admin/audit";
import { recoverOrder } from "@/lib/offramp/burn-backstop";
import { diagnoseOrder } from "@/lib/offramp/diagnose";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Register a stranded burn (or nudge a stalled one) for a single order, now.
 *
 * This is the button that means a user doesn't wait for the 03:17 sweep.
 * `ignoreGrace` is on: an admin clicking this has better information than
 * the 8 minute timer that exists to stop the sweep racing a live client.
 *
 * Idempotent — recoverOrder no-ops when a transfer already exists, and the
 * matcher requires both mint recipient and amount to agree.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorisedAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const orderId = typeof body?.orderId === "string" ? body.orderId.trim() : "";
  const operator = typeof body?.operator === "string" ? body.operator.trim() : "";

  if (!orderId) {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  try {
    const result = await recoverOrder(orderId, { ignoreGrace: true });
    await recordAdminAction({
      action: "recover-order",
      orderId,
      operator: operator || "unknown",
      outcome: result.outcome,
      detail: result.burnTxHash,
    });
    // Hand back the fresh picture so the screen updates from truth rather
    // than assuming the action worked.
    return NextResponse.json({
      data: { result, diagnosis: await diagnoseOrder(orderId) },
    });
  } catch (err: any) {
    await recordAdminAction({
      action: "recover-order",
      orderId,
      operator: operator || "unknown",
      outcome: "error",
      detail: err?.message,
    });
    return NextResponse.json({ error: err?.message || "Recovery failed" }, { status: 500 });
  }
}
