import { NextRequest, NextResponse } from "next/server";
import { retryOnrampBridge } from "@/lib/onramp/retry-bridge";
import { requireAdmin, recordOutcome } from "@/lib/admin/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Manually re-attempt a stuck onramp bridge — e.g. after funding the hot
 * wallet with Base ETH once a bridge_failed gas alert comes in. Safe to call
 * repeatedly: retryOnrampBridge reuses handleOnrampSettled's lock + hold-and-
 * alert semantics, so a duplicate call while one is in flight is a no-op.
 *
 * Auth: a signed-in admin account. Log in, then send the session token as
 * `Authorization: Bearer <token>`.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const orderId = String(body?.orderId ?? "").trim();
  if (!orderId) {
    return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
  }
  const amount = body?.amount ? String(body.amount) : undefined;

  let audit;
  try {
    audit = await requireAdmin(request, "onramp.retry_bridge", { orderId, amount });
  } catch {
    // Fails closed: unset config, an unreachable API and a non-admin caller
    // all land here, and none is a reason to run an admin action.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await retryOnrampBridge(orderId, amount);
  recordOutcome(audit.auditId, result.ok ? "ok" : "conflict", result);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
