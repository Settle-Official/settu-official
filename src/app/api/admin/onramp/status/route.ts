import { NextRequest, NextResponse } from "next/server";
import { checkOnrampStatus } from "@/lib/onramp/check-status";
import { requireAdmin, recordOutcome } from "@/lib/admin/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * On-demand onramp status check — the HTTP twin of the Telegram "Check
 * status" button, for orders that predate that button or when you'd rather
 * curl than tap. If the order is `bridging`, this actively re-checks
 * Allbridge instead of waiting for the once-daily cron.
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

  let audit;
  try {
    audit = await requireAdmin(request, "onramp.check_status", { orderId });
  } catch {
    // Fails closed: unset config, an unreachable API and a non-admin caller
    // all land here, and none is a reason to run an admin action.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await checkOnrampStatus(orderId);
  recordOutcome(audit.auditId, "ok", result);
  return NextResponse.json(result);
}
