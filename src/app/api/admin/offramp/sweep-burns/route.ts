import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { runSweepBurns } from "@/lib/admin/sweep-burns";
import { sweepBridgedEvents } from "@/lib/bridge/event-sweep";
import { reconcileUnregisteredBurns } from "@/lib/offramp/burn-backstop";

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
 * Auth: `Authorization: Bearer $ADMIN_API_SECRET` or an admin console
 * session. Fails closed — refused when ADMIN_API_SECRET is unset.
 *
 * Also runs the user-bridge event sweep (`sweepBridgedEvents`) on the same
 * 5-minute QStash schedule. That is additive only: its result is under the
 * `bridgeSweep` key and its failure never changes the offramp result or
 * status code (see src/lib/admin/sweep-burns.ts).
 */
export async function POST(request: NextRequest) {
  if (!isAuthorisedAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { status, body } = await runSweepBurns({
    offrampSweep: reconcileUnregisteredBurns,
    bridgeSweep: () => sweepBridgedEvents(),
    log: (m) => console.error(m),
  });
  return NextResponse.json(body, { status });
}
