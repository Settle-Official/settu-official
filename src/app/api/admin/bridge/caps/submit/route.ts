import { NextRequest, NextResponse } from "next/server";
import { bridgeCapsSubmitPost } from "@/lib/admin/bridge-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST { signedXdr } — submit the owner-signed Stellar limit change to the
 * configured Soroban RPC (CCTP_CONFIG.stellarRpcUrl, testnet-aware).
 * → { hash, status }. Admin auth (cookie or bearer) required; 401 otherwise.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const r = await bridgeCapsSubmitPost(request, body);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
