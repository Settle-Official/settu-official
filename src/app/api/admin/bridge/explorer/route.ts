import { NextRequest, NextResponse } from "next/server";
import { explorerGet } from "@/lib/bridge/explorer-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET → { rows, nextCursor? } (filters: cursor limit status source dest speed
 * from to q) or `?totals=24h|7d` → { totals }. Admin auth first; 401 otherwise.
 */
export async function GET(request: NextRequest) {
  const r = await explorerGet(request);
  return NextResponse.json(r.body, { status: r.status, headers: { "Cache-Control": "no-store" } });
}
