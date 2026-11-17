import { NextRequest, NextResponse } from "next/server";
import { bridgeListGet } from "@/lib/admin/bridge-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → { bridges } — recent and pending bridges with their status views,
 * newest first; `?id=<source tx>` returns just that one.
 * Admin auth (cookie or bearer) required; 401 otherwise.
 */
export async function GET(request: NextRequest) {
  const id = new URL(request.url).searchParams.get("id");
  const r = await bridgeListGet(request, id);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
