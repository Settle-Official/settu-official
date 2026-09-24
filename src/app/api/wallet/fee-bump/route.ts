import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import {
  FeeBumpRejected,
  SponsorUnavailableError,
  feeBumpAndSubmit,
} from "@/lib/settu-wallet/sponsor";

export const runtime = "nodejs";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Fees are trivial individually; the limit is against someone burning the
// sponsor's balance by submitting in a loop.
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 3600;

/** Submits a user-signed transaction with Settu paying the fee. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const xdr = String(body?.xdr ?? "").trim();
  if (!xdr) {
    return NextResponse.json({ error: "xdr is required" }, { status: 400 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `wallet:feebump:rate:${ip}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, RATE_WINDOW_SECONDS);
  if (used > RATE_LIMIT) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const result = await feeBumpAndSubmit(xdr);
    return NextResponse.json({ hash: result.hash, successful: true });
  } catch (error) {
    if (error instanceof FeeBumpRejected) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof SponsorUnavailableError) {
      console.error("[wallet] sponsor unavailable:", error.message);
      return NextResponse.json(
        { error: "Transactions are temporarily unavailable" },
        { status: 503 },
      );
    }
    // Horizon rejections carry the reason in extras; surface it for the UI.
    const detail = (error as { response?: { data?: unknown } })?.response?.data;
    console.error("[wallet] fee bump failed:", detail ?? error);
    return NextResponse.json(
      { error: "The network rejected that transaction" },
      { status: 502 },
    );
  }
}
