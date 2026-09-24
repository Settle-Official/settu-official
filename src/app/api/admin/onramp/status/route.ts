import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { checkOnrampStatus } from "@/lib/onramp/check-status";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * On-demand onramp status check — the HTTP twin of the Telegram "Check
 * status" button, for orders that predate that button or when you'd rather
 * curl than tap. If the order is `bridging`, this actively re-checks
 * Allbridge instead of waiting for the once-daily cron.
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

  const result = await checkOnrampStatus(orderId);
  return NextResponse.json(result);
}
