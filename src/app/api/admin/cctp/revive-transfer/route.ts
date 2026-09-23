import { NextRequest, NextResponse } from "next/server";
import { reviveStuckTransfer } from "@/lib/cctp/revive";
import { requireAdmin, recordOutcome } from "@/lib/admin/guard";

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
 * Auth: a signed-in admin account. Log in, then send the session token as
 * `Authorization: Bearer <token>`.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const transferId = String(body?.transferId ?? "").trim();
  if (!transferId) {
    return NextResponse.json({ error: "Missing transferId" }, { status: 400 });
  }
  const orderId = body?.orderId ? String(body.orderId).trim() : undefined;

  let audit;
  try {
    audit = await requireAdmin(request, "cctp.revive_transfer", {
      transferId,
      orderId,
    });
  } catch {
    // Fails closed: unset config, an unreachable API and a non-admin caller
    // all land here, and none is a reason to run an admin action.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await reviveStuckTransfer(transferId, orderId);
  recordOutcome(audit.auditId, result.ok ? "ok" : "conflict", result);
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
