import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { reviveStuckTransfer } from "@/lib/cctp/revive";

export const runtime = "nodejs";
export const maxDuration = 45;

/**
 * Manually recovers a CCTP transfer wrongly frozen `failed` — e.g. it
 * exhausted its retry budget while a required secret or gas balance was
 * missing, not from a genuine on-chain failure. Resumes from whatever step
 * the record already reached (never re-burns). For an onramp transfer, pass
 * `orderId` (from the original bridge_failed alert) to also un-stick the
 * owning order so the SSE stream can pick it back up.
 *
 * Auth: `Authorization: Bearer $ADMIN_API_SECRET` or an admin console
 * session. Fails closed — refused when ADMIN_API_SECRET is unset.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorisedAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const transferId = String(body?.transferId ?? "").trim();
  if (!transferId) {
    return NextResponse.json({ error: "Missing transferId" }, { status: 400 });
  }
  const orderId = body?.orderId ? String(body.orderId).trim() : undefined;

  const result = await reviveStuckTransfer(transferId, orderId);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
