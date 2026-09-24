import { NextRequest, NextResponse } from "next/server";
import { getStats, trackWallet } from "@/lib/stats-store";
import { createRateLimit, clientIp } from "@/lib/rate-limit";

// Wallet connects are rare per person and this route is public, so the budget
// only has to be generous enough for a real browser.
const limiter = createRateLimit(20, 60_000);

const MAX_ADDRESS_LENGTH = 128;

export async function GET() {
  return NextResponse.json(await getStats());
}

export async function POST(request: NextRequest) {
  if (!limiter.check(clientIp(request.headers))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Only `wallet` is accepted. This route used to take `volume` and
  // `transaction` too, which let anyone inflate the public counters.
  const { wallet } = await request.json().catch(() => ({ wallet: undefined }));
  if (typeof wallet === "string" && wallet.length <= MAX_ADDRESS_LENGTH) {
    await trackWallet(wallet);
  }

  return NextResponse.json(await getStats());
}
