import { NextRequest, NextResponse } from "next/server";
import { bridgeFeeGet, bridgeFeePut } from "@/lib/admin/bridge-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET  → { standardBps, fastBps, audit, lowestCapBps, capSource }
 * PUT  { speed, feeBps, operator } → setBridgeFeeBps; 400 fee_above_cap when
 *      above the lowest on-chain cap (env cap when nothing is deployed).
 * Admin auth (cookie or bearer) required; 401 otherwise.
 */
export async function GET(request: NextRequest) {
  const r = await bridgeFeeGet(request);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const r = await bridgeFeePut(request, body);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
