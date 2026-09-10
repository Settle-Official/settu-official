import { NextRequest, NextResponse } from "next/server";
import { listPendingBridges } from "@/lib/onramp/onramp-store";
import { initializeAllbridgeSdk } from "@/lib/offramp/adapters/allbridge-adapter";
import { finalizeOnrampOrder } from "@/lib/onramp/finalize";
import { listPendingTransfers } from "@/lib/cctp/cctp-store";
import { advanceCctpTransfer } from "@/lib/cctp/advance";
import { reconcileUnregisteredBurns } from "@/lib/offramp/burn-backstop";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Backstop finalizer: sweeps all in-flight Base→Stellar bridges and advances
 * any that have confirmed. On Vercel Hobby this only fires once per day (the
 * open SSE session is the fast path); on Pro it can run every couple minutes.
 * Idempotent — safe at any cadence.
 *
 * Auth: Vercel cron sends `Authorization: Bearer $CRON_SECRET`. Required in
 * production; if CRON_SECRET is unset the call is allowed (local/dev).
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const orderIds = await listPendingBridges();
  let delivered = 0;
  let stillPending = 0;

  if (orderIds.length > 0) {
    // Allbridge-era backstop. Left wired (not removed) since it's still the
    // path for any order that predates the CCTP cutover, but new orders no
    // longer populate this set — see the CCTP sweep below, which now covers
    // both onramp and offramp regardless of this loop.
    const sdk = await initializeAllbridgeSdk();
    for (const orderId of orderIds) {
      try {
        const outcome = await finalizeOnrampOrder(sdk, orderId);
        if (outcome === "delivered") delivered++;
        else if (outcome === "pending") stillPending++;
      } catch {
        // Transient error on one order shouldn't stop the sweep.
        stillPending++;
      }
    }
  }

  const cctpIds = await listPendingTransfers();
  let cctpAdvanced = 0;
  for (const id of cctpIds) {
    try {
      await advanceCctpTransfer(id);
      cctpAdvanced++;
    } catch {
      // Transient error on one transfer shouldn't stop the sweep.
    }
  }

  // Backstop: find offramp burns that confirmed on-chain but whose
  // client-side registration was lost, and get them into the pipeline above.
  let burnBackstop: Awaited<ReturnType<typeof reconcileUnregisteredBurns>> | null =
    null;
  try {
    burnBackstop = await reconcileUnregisteredBurns();
  } catch (err) {
    console.error("[cron] burn-backstop sweep failed:", err);
  }

  return NextResponse.json({
    checked: orderIds.length,
    delivered,
    stillPending,
    cctpChecked: cctpIds.length,
    cctpAdvanced,
    burnBackstop,
  });
}
