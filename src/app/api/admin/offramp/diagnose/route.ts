import { NextRequest, NextResponse } from "next/server";
import { isAuthorisedAdmin } from "@/lib/admin/auth";
import { diagnoseOrder, diagnoseWallet } from "@/lib/offramp/diagnose";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Read-only. Joins every source of truth for a wallet or a single order and
 * says what's wrong — the forty minutes of hand-querying a real recovery
 * took, in one call.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorisedAdmin(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId")?.trim();
  const wallet = url.searchParams.get("wallet")?.trim();

  try {
    if (orderId) {
      return NextResponse.json({ data: { orders: [await diagnoseOrder(orderId)] } });
    }
    if (wallet) {
      if (wallet.length < 8 || wallet.length > 128) {
        return NextResponse.json({ error: "Invalid wallet address" }, { status: 400 });
      }
      return NextResponse.json({ data: { orders: await diagnoseWallet(wallet) } });
    }
    return NextResponse.json(
      { error: "Pass either ?orderId= or ?wallet=" },
      { status: 400 },
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Diagnosis failed" },
      { status: 500 },
    );
  }
}
