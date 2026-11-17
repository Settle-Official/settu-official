import { NextRequest, NextResponse } from "next/server";
import { BRIDGE_CHAINS, type BridgeChainKey } from "@/lib/bridge/chains";
import { BridgeRegisterError, registerBridge, toStatusView } from "@/lib/bridge/bridge-store";
import { scheduleDriveOnRegister } from "@/lib/bridge/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/bridge/register { chain, txHash } -> BridgeStatusView.
 * Idempotent. Only the chain and hash are read from the client; every
 * amount comes from the on-chain event. Registration schedules server-side
 * driving (QStash, src/lib/bridge/schedule.ts), so the bridge completes even
 * if the user closes the app.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const chain = b?.chain;
  const txHash = b?.txHash;
  if (
    typeof chain !== "string" ||
    !Object.prototype.hasOwnProperty.call(BRIDGE_CHAINS, chain) ||
    typeof txHash !== "string"
  ) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  try {
    const record = await registerBridge(chain as BridgeChainKey, txHash, scheduleDriveOnRegister);
    return NextResponse.json(toStatusView(record), { headers: NO_STORE });
  } catch (e) {
    if (e instanceof BridgeRegisterError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: NO_STORE });
    }
    console.error("[bridge/register] failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "Could not register the transfer." }, { status: 503, headers: NO_STORE });
  }
}
