import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { notify } from "@/lib/notify/telegram";

export const runtime = "nodejs";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const MAX_FIELD = 600;
const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 300;

/** Truncated, single-line, and stripped of anything key-shaped. */
function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/[SG][A-Z2-7]{55}|0x[a-fA-F0-9]{64}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, MAX_FIELD);
}

/**
 * Client-side failure reports. A mobile browser's console is unreachable, so
 * without this a wallet error that only reproduces on a phone can't be read.
 */
export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const key = `client-error:rate:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RATE_WINDOW_SECONDS);
  if (count > RATE_LIMIT) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }

  const body = await request.json().catch(() => ({}));
  const context = clean(body?.context);
  const detail = clean(body?.detail);
  if (!context && !detail) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  await notify(
    [
      "🐞 <b>Client error</b>",
      `Context: ${context || "—"}`,
      `Step: ${clean(body?.step) || "—"}`,
      `Chain: ${clean(body?.chain) || "—"}`,
      `UA: ${clean(request.headers.get("user-agent"))}`,
      "",
      `<pre>${detail}</pre>`,
    ].join("\n"),
    "warning",
  );

  return NextResponse.json({ ok: true });
}
