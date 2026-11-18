import { NextRequest, NextResponse } from "next/server";
import { getCctpTransfer } from "@/lib/cctp/cctp-store";
import { normaliseBridgeId, toStatusView } from "@/lib/bridge/bridge-store";
import { buildSelfClaimTx, confirmSelfClaim, SelfClaimError } from "@/lib/bridge/self-claim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/bridge/[id]/claim → { family: "evm", chainId, to, data }: the
 * unsigned mint for the user's own destination wallet ("Claim it yourself").
 * Public data only (Circle's attestation is public); anyone may submit it.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await getCctpTransfer(normaliseBridgeId(id));
    if (!r || r.direction !== "bridge") {
      return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(buildSelfClaimTx(r), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof SelfClaimError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409, headers: NO_STORE });
    }
    console.error("[bridge/claim] failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Claim unavailable right now." }, { status: 503, headers: NO_STORE });
  }
}

/**
 * POST /api/bridge/[id]/claim { txHash } → BridgeStatusView: after the user's
 * wallet sent the claim, confirm it on-chain and complete the bridge.
 * 409 while the claim hasn't landed yet (the client retries).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { txHash?: unknown } | null;
  const txHash = typeof body?.txHash === "string" ? body.txHash.trim() : "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "Invalid transaction hash." }, { status: 400, headers: NO_STORE });
  }
  try {
    const done = await confirmSelfClaim(normaliseBridgeId(id), txHash);
    return NextResponse.json(toStatusView(done), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof SelfClaimError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 409, headers: NO_STORE });
    }
    // Most often the claim tx isn't mined yet; the client retries.
    console.error("[bridge/claim] confirm failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "The claim hasn't confirmed yet.", code: "not_yet" }, { status: 409, headers: NO_STORE });
  }
}
