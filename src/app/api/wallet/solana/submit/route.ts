import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { requireSolanaRpcUrl } from "@/lib/solana/config";

export const runtime = "nodejs";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// The user pays their own fees, so this spends nothing of ours. The limit is
// against the endpoint being used as a free RPC relay.
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 3600;

/** Relays an already-signed transaction, keeping the RPC key server-side. */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const signed = String(body?.transaction ?? "").trim();
  if (!signed) {
    return NextResponse.json(
      { error: "transaction is required" },
      { status: 400 },
    );
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `wallet:solana-submit:${ip}`;
  const used = await redis.incr(key);
  if (used === 1) await redis.expire(key, RATE_WINDOW_SECONDS);
  if (used > RATE_LIMIT) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let raw: Buffer;
  try {
    raw = Buffer.from(signed, "base64");
    // Parsing first means a malformed blob fails here rather than at the RPC.
    VersionedTransaction.deserialize(Uint8Array.from(raw));
  } catch {
    return NextResponse.json(
      { error: "That transaction could not be parsed" },
      { status: 400 },
    );
  }

  try {
    const connection = new Connection(requireSolanaRpcUrl(), "confirmed");
    const signature = await connection.sendRawTransaction(raw);
    return NextResponse.json({ signature });
  } catch (error: any) {
    // Solana's reason lives in logs; surface it so the UI can be specific.
    const logs = error?.logs?.slice(0, 3);
    console.error("[wallet] solana submit failed:", error?.message, logs);
    return NextResponse.json(
      { error: error?.message ?? "The network rejected that transaction" },
      { status: 502 },
    );
  }
}
