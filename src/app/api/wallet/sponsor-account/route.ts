import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { StrKey } from "@stellar/stellar-sdk";
import {
  SponsorUnavailableError,
  accountExists,
  signSponsoredCreation,
} from "@/lib/stellar/settu-wallet/sponsor";

export const runtime = "nodejs";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Each sponsored account locks reserves, so this is a spend, not just a write.
const RATE_LIMIT = 5;
const RATE_WINDOW_SECONDS = 3600;

/** Returns a sponsor-signed creation XDR; the caller signs and submits it. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const publicKey = String(body?.publicKey ?? "").trim();

  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    return NextResponse.json(
      { error: "A valid Stellar public key is required" },
      { status: 400 },
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `wallet:sponsor:rate:${ip}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, RATE_WINDOW_SECONDS);
  if (used > RATE_LIMIT) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Sponsoring an existing account would burn reserves for nothing.
  if (await accountExists(publicKey)) {
    return NextResponse.json(
      { error: "That account already exists on Stellar" },
      { status: 409 },
    );
  }

  try {
    const xdr = await signSponsoredCreation(publicKey);
    return NextResponse.json({ xdr });
  } catch (error) {
    // A missing or drained sponsor is an operational problem, not the caller's.
    if (error instanceof SponsorUnavailableError) {
      console.error("[wallet] sponsor unavailable:", error.message);
      return NextResponse.json(
        { error: "Wallet creation is temporarily unavailable" },
        { status: 503 },
      );
    }
    throw error;
  }
}
