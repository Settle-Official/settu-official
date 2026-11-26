import { NextRequest, NextResponse } from "next/server";
import { BUILDING, CHAINS, MARKETS, NEEDS, VOLUMES, toSheetRow, validateWaitlist } from "@/lib/waitlist/schema";
import { appendWaitlistRow, sheetsConfigured } from "@/lib/waitlist/sheets";
import { alertWaitlistSignup } from "@/lib/notify/telegram";
import { clientIp, createRateLimit } from "@/lib/rate-limit";

// Five sign-ups per IP per 10 minutes is plenty for a person and stops a script.
const limiter = createRateLimit(5, 10 * 60 * 1000);

const label = (opts: readonly { value: string; label: string }[], v: string) => opts.find((o) => o.value === v)?.label ?? v;

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }

  // Honeypot: a field humans never see. Bots fill it; pretend all went well.
  if (body && typeof body === "object" && (body as Record<string, unknown>).website) return NextResponse.json({ ok: true });

  if (!limiter.check(clientIp(request.headers))) {
    return NextResponse.json({ error: "Too many sign-ups from here. Please try again in a few minutes." }, { status: 429 });
  }

  const result = validateWaitlist(body);
  if (!result.ok) return NextResponse.json({ error: "Please check the highlighted fields.", fields: result.errors }, { status: 400 });
  const e = result.entry;

  let savedToSheet = false;
  if (sheetsConfigured()) {
    try { await appendWaitlistRow(toSheetRow(e, new Date())); savedToSheet = true; }
    catch (err) { console.error("[waitlist] sheet append failed", err instanceof Error ? err.message : err); }
  } else {
    console.error("[waitlist] Google Sheets env is not configured");
  }

  const alerted = await alertWaitlistSignup({
    email: e.email, name: e.name, company: e.company,
    need: label(NEEDS, e.need), building: label(BUILDING, e.building),
    markets: e.markets.map((m) => label(MARKETS, m)).join(", "),
    chains: e.chains.map((c) => label(CHAINS, c)).join(", "),
    volume: e.volume ? label(VOLUMES, e.volume) : "",
    useCase: e.useCase, heardFrom: e.heardFrom, savedToSheet,
  });

  // Stored somewhere we can read it → the sign-up counts. Neither → say so.
  if (!savedToSheet && !alerted) {
    return NextResponse.json({ error: "We couldn't save your sign-up just now. Please try again shortly." }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}
