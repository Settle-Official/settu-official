import { NextRequest, NextResponse } from "next/server";
import { reconcileUnregisteredBurns } from "@/lib/offramp/burn-backstop";
import { requireAdmin, recordOutcome } from "@/lib/admin/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Finds CCTP offramp burns that confirmed on-chain but whose client-side
 * registration (`/api/offramp/bridge/register-transfer`) was lost, and
 * registers them so the attest→mint pipeline delivers the USDC to Paycrest.
 *
 * The manual sibling of the daily cron's burn-backstop pass — run this when a
 * user reports "funds debited but the transfer failed". Safe to run
 * repeatedly (registration is idempotent). Scope: Stellar source only.
 * Auth: a signed-in admin account. Log in, then send the session token as
 * `Authorization: Bearer <token>`.
 */
export async function POST(request: NextRequest) {
  let audit;
  try {
    audit = await requireAdmin(request, "offramp.sweep_burns");
  } catch {
    // Fails closed: unset config, an unreachable API and a non-admin caller
    // all land here, and none is a reason to run an admin action.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await reconcileUnregisteredBurns();
    recordOutcome(audit.auditId, "ok", result);
    return NextResponse.json(result);
  } catch (err: any) {
    recordOutcome(audit.auditId, "error", { message: err?.message });
    return NextResponse.json(
      { error: err?.message || "burn sweep failed" },
      { status: 500 },
    );
  }
}
