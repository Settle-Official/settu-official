import { NextRequest, NextResponse } from "next/server";
import { getBridgeStatus } from "@/lib/bridge/bridge-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/bridge/[id] -> BridgeStatusView (id is the source tx hash). */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const view = await getBridgeStatus(id);
    if (!view) return NextResponse.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    return NextResponse.json(view, { headers: NO_STORE });
  } catch (e) {
    console.error("[bridge/status] failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Status unavailable." }, { status: 503, headers: NO_STORE });
  }
}
