import { NextRequest, NextResponse } from "next/server";
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
 * Auth: `Authorization: Bearer $ADMIN_API_SECRET` (required in production).
 */
export async function POST(request: NextRequest) {
  const secret = process.env.ADMIN_API_SECRET;
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const result = await reconcileUnregisteredBurns();
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "burn sweep failed" },
      { status: 500 },
    );
  }
}
