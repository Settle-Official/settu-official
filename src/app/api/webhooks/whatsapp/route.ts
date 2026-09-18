import { NextRequest, NextResponse } from "next/server";
import { isValidSignature, sendMessage } from "@/lib/whatsapp/client";
import { createIntent } from "@/lib/whatsapp/intents";

export const runtime = "nodejs";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.settu.xyz";

/** Meta's one-time subscription handshake. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (
    verifyToken &&
    params.get("hub.mode") === "subscribe" &&
    params.get("hub.verify_token") === verifyToken
  ) {
    return new NextResponse(params.get("hub.challenge") ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

// Nothing here moves funds: a request becomes an intent the user signs for in
// the web app, so a compromised thread cannot spend.
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Ack rather than reject, so Meta doesn't retry-storm and a stranger learns
  // nothing from the response.
  if (!(await isValidSignature(rawBody, request.headers.get("x-hub-signature-256")))) {
    return NextResponse.json({ ok: true });
  }

  const message = firstTextMessage(rawBody);
  if (!message) return NextResponse.json({ ok: true });

  const text = message.text.trim();
  if (/^(hi|hello|help|start)$/i.test(text)) {
    await sendMessage(
      message.from,
      "Settu here. Tell me what you want to do — for example “offramp 50 USDC” — and I'll send you a link to approve it.",
    );
    return NextResponse.json({ ok: true });
  }

  // The agent layer resolves the wording; this transport only carries it.
  const token = await createIntent(message.from, text);
  await sendMessage(
    message.from,
    `Open this to review and approve:\n${APP_URL}/wallet/approve?intent=${token}\n\nThe link works once and expires in 15 minutes.`,
  );
  return NextResponse.json({ ok: true });
}

interface InboundMessage {
  from: string;
  text: string;
}

function firstTextMessage(rawBody: string): InboundMessage | null {
  try {
    const body = JSON.parse(rawBody);
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (message?.type !== "text" || !message?.from) return null;
    return { from: String(message.from), text: String(message.text?.body ?? "") };
  } catch {
    return null;
  }
}
