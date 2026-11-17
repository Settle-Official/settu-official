import { NextRequest, NextResponse } from "next/server";
import { bridgeCapsGet, bridgeCapsPost } from "@/lib/admin/bridge-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET  → maxFeeBps / maxNetworkFee / maxNativeFee from all 8 bridge contracts.
 *        Undeployed chains are "not_deployed"; Solana is "not_available".
 * POST { chain, limit, value, ownerAddress } → an UNSIGNED owner transaction
 *        for the owner wallet in the browser to sign. The server holds no
 *        owner key. 400 cap_below_fee: "Lower the bridge fee first".
 * Admin auth (cookie or bearer) required; 401 otherwise.
 */
export async function GET(request: NextRequest) {
  const r = await bridgeCapsGet(request);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const r = await bridgeCapsPost(request, body);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
