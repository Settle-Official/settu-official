import { NextRequest, NextResponse } from "next/server";
import { bridgeRevivePost } from "@/lib/admin/bridge-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// reviveStuckTransfer advances inline for up to ~18 s before scheduleDrive.
export const maxDuration = 45;

/**
 * POST { id, operator } — revive a `failed` bridge (reviveStuckTransfer),
 * then schedule the server-side drive. Audited under the operator's name.
 * Admin auth (cookie or bearer) required; 401 otherwise.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const r = await bridgeRevivePost(request, body);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
