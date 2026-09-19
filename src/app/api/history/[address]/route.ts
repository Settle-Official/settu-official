import { NextRequest, NextResponse } from "next/server";
import { listByAddress } from "@/lib/offramp/transaction-history";

/**
 * A wallet's offramp history, straight from the permanent Redis record
 * (`offramp:tx:by-address:*`) that every source chain writes on registration.
 * This is the cross-device source of truth the dashboard's totals need —
 * localStorage only ever knew about transactions made in one browser.
 *
 * Onramp orders are deliberately absent: they're stored per order id with a
 * 7-day TTL and no per-address index, so they can't be listed for a wallet
 * yet (see the onramp store).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    if (!address || address.length < 8 || address.length > 128) {
      return NextResponse.json({ error: "Invalid address" }, { status: 400 });
    }

    const limitParam = Number(request.nextUrl.searchParams.get("limit"));
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 200)
        : 100;

    const offramp = await listByAddress(address, { limit });
    return NextResponse.json({ data: { offramp } });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || "Failed to load history" },
      { status: 500 },
    );
  }
}
