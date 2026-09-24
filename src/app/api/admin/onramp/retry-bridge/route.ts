import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { retryOnrampBridge } from "@/lib/onramp/retry-bridge";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Manually re-attempt a stuck onramp bridge — e.g. after funding the hot
 * wallet with Base ETH once a bridge_failed gas alert comes in. Safe to call
 * repeatedly: retryOnrampBridge reuses handleOnrampSettled's lock + hold-and-
 * alert semantics, so a duplicate call while one is in flight is a no-op.
 *
 * Auth: `Authorization: Bearer $ADMIN_API_SECRET` or an admin console
 * session. Fails closed — refused when ADMIN_API_SECRET is unset.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorisedAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const orderId = String(body?.orderId ?? "").trim();
  if (!orderId) {
    return NextResponse.json({ error: "Missing orderId" }, { status: 400 });
  }
  const amount = body?.amount ? String(body.amount) : undefined;

  const result = await retryOnrampBridge(orderId, amount);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
