import { NextRequest, NextResponse } from "next/server";
import { SubmitStellarError, submitStellarBridgeTx } from "@/lib/bridge/submit-stellar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/bridge/submit-stellar { signedXdr } → { hash }.
 * Relays only a single `bridge` call on Settu's Stellar bridge contract.
 */
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { signedXdr?: unknown } | null;
  if (!body || typeof body.signedXdr !== "string" || !body.signedXdr) {
    return NextResponse.json({ error: "Invalid request.", code: "invalid_request" }, { status: 400, headers: NO_STORE });
  }
  try {
    return NextResponse.json(await submitStellarBridgeTx(body.signedXdr), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof SubmitStellarError) {
      const status = e.code === "unavailable" ? 503 : 400;
      if (e.code === "unavailable") console.error("[bridge/submit-stellar]", e.message);
      return NextResponse.json({ error: e.message, code: e.code }, { status, headers: NO_STORE });
    }
    console.error("[bridge/submit-stellar] failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json(
      { error: "Couldn't submit the transaction right now. Try again in a moment.", code: "unavailable" },
      { status: 503, headers: NO_STORE },
    );
  }
}
