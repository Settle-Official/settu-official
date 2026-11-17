import { NextRequest, NextResponse } from "next/server";
import { BRIDGE_CHAINS, type BridgeChainKey } from "@/lib/bridge/chains";
import { validateDestinationAddress } from "@/lib/bridge/address";
import { readUsdcBalance } from "@/lib/bridge/usdc-balance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/bridge/balance?chain=<key>&address=<addr> → { atomic, decimals }.
 * The From card's balance and Max. Read-only; the address is format-checked
 * with the same per-chain rules as a destination.
 */
export async function GET(request: NextRequest) {
  const chain = request.nextUrl.searchParams.get("chain") ?? "";
  const address = request.nextUrl.searchParams.get("address") ?? "";
  if (!(chain in BRIDGE_CHAINS)) {
    return NextResponse.json({ error: "Unknown chain." }, { status: 400 });
  }
  const check = validateDestinationAddress(chain as BridgeChainKey, address);
  if (!check.ok && check.code !== "forbidden") {
    return NextResponse.json({ error: check.message }, { status: 400 });
  }
  try {
    const balance = await readUsdcBalance(chain as BridgeChainKey, address.trim());
    return NextResponse.json(balance, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[bridge/balance] failed:", e instanceof Error ? e.message : "unknown error");
    return NextResponse.json({ error: "Couldn't read your balance." }, { status: 503 });
  }
}
