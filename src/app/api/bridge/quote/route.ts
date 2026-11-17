import { NextRequest, NextResponse } from "next/server";
import {
  buildQuote,
  httpStatusFor,
  QUOTE_UNAVAILABLE_MESSAGE,
  type QuoteRequest,
} from "@/lib/bridge/build-quote";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/bridge/quote — a signed bridge quote plus the breakdown the UI
 * shows. Body: { source, dest, amount, speed, user, recipient, networkFeeMode }.
 *
 * 200 { quote, signature, breakdown, expiresAt, contract } (bigints as decimal strings)
 * 400 validation ({ error, code }) · 409 fast_unavailable · 503 fee_config / unavailable.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request.", code: "invalid_request" },
      { status: 400 },
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Invalid request.", code: "invalid_request" },
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const req = {
    source: b.source,
    dest: b.dest,
    amount: b.amount,
    speed: b.speed,
    user: b.user,
    recipient: b.recipient,
    networkFeeMode: b.networkFeeMode,
  } as QuoteRequest; // every field is re-validated by buildQuote

  try {
    const result = await buildQuote(req);
    if ("error" in result) {
      return NextResponse.json(result, {
        status: httpStatusFor(result.code),
        headers: { "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    // Config errors (missing contract/signer env) and internal invariants.
    // Log the message only — never the stack or any key material.
    console.error(
      "[bridge/quote] failed:",
      e instanceof Error ? `${e.name}: ${e.message}` : "unknown error",
    );
    return NextResponse.json(
      { error: QUOTE_UNAVAILABLE_MESSAGE, code: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
