import { NextRequest, NextResponse } from "next/server";
import { PaycrestAdapter } from "@/lib/offramp/adapters/paycrest-adapter";
import { getPayoutStatus } from "@/lib/offramp/payout-store";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const { orderId } = await params;

    // Redis is the source of truth (webhook-driven). Serve it when present so
    // clients that fall back to polling still see webhook updates.
    const cached = await getPayoutStatus(orderId);
    if (cached) {
      return NextResponse.json({
        data: { id: orderId, status: cached.status },
        source: "webhook",
      });
    }

    const apiKey = process.env.PAYCREST_API_KEY;
    if (!apiKey) {
      throw new Error("PAYCREST_API_KEY not configured");
    }

    // Orders are created on v2, which is not guaranteed to be readable through
    // the v1 endpoint. This is the polling backstop behind the SSE stream.
    const paycrest = new PaycrestAdapter(apiKey);
    const status = await paycrest.getOrderStatusV2(orderId);

    return NextResponse.json({ data: status, source: "api" });
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Failed to fetch Paycrest order status" },
      { status: 500 }
    );
  }
}
