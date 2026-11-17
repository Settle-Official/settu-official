import { NextRequest, NextResponse } from "next/server";
import { bridgeRelayersGet } from "@/lib/admin/bridge-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → { relayers } — native balance of the relayer on each of the 8 chains,
 * from BRIDGE_{EVM,STELLAR,SOLANA}_RELAYER_ADDRESS (addresses only, never
 * keys). Unset → "not_configured".
 * Admin auth (cookie or bearer) required; 401 otherwise.
 */
export async function GET(request: NextRequest) {
  const r = await bridgeRelayersGet(request);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
