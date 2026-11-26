import { NextRequest, NextResponse } from "next/server";
import { getBeneficiary } from "@/lib/offramp/beneficiary-store";

export const runtime = "nodejs";

/**
 * Where a settled offramp paid out, so History can offer "Repeat transfer".
 *
 * Proxied rather than called from the browser because the service token is
 * server-only. Resolvable only with the order id itself — an unguessable
 * UUID — so nothing here can be enumerated from a wallet address.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await params;
  if (!orderId || orderId.length > 120) {
    return NextResponse.json({ error: "Invalid order id" }, { status: 400 });
  }

  try {
    return NextResponse.json({ beneficiary: await getBeneficiary(orderId) });
  } catch {
    // A sleeping or unreachable backend costs a Repeat button, nothing more,
    // so answer as though there were none rather than failing the receipt.
    return NextResponse.json({ beneficiary: null });
  }
}
