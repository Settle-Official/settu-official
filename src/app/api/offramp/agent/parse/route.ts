import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { sourceChainOptions } from "@/lib/offramp/source-chain-options";
import { fetchCurrencies } from "@/lib/offramp/paycrest-directory";
import {
  classifyExtraction,
  resolveAgentOrder,
  type AgentOrderExtraction,
} from "@/lib/offramp/agent-resolver";
import {
  classifyOnrampExtraction,
  resolveOnrampOrder,
  type OnrampAgentExtraction,
} from "@/lib/offramp/agent-onramp-resolver";
import { checkAgentRateLimit } from "@/lib/offramp/agent-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

// Called directly against Google's own API (bypassing the Vercel AI Gateway)
// so this runs on Google's genuinely free tier — every "free"-tagged model on
// the Gateway turned out to be unreliable in practice (billing walls, empty
// 400s, schemas ignored, 503/429 flapping under shared load). The package's
// own default env var is GOOGLE_GENERATIVE_AI_API_KEY; GOOGLE_GEMINI_API_KEY
// is accepted too since that's the name it's easy to reach for first.
const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY,
});

const extractionSchema = z.object({
  direction: z.enum(["onramp", "offramp"]).nullable().describe(
    "Whether the user wants to convert fiat to crypto (onramp — they're paying money to receive USDC) or crypto to fiat (offramp — they're sending USDC to receive money in their bank). Null if genuinely ambiguous.",
  ),
  // Offramp fields.
  amount: z.string().nullable().describe("The numeric USDC amount, as a plain string, e.g. \"1000\". Null if not stated. Offramp only."),
  token: z.string().nullable().describe("The token symbol, e.g. \"USDC\". Null if not stated — default to USDC if the user clearly means a stablecoin offramp but didn't name one. Offramp only."),
  sourceChain: z.string().nullable().describe("The lowercase chain key the user is sending from, matching one of the allowed values. Null if not stated or unclear. Offramp only."),
  destinationCurrency: z.string().nullable().describe("The 3-letter fiat currency code the recipient should be paid in, inferred from context (e.g. a Nigerian bank implies NGN) if not stated explicitly. Null only if truly unclear. Offramp only."),
  institutionName: z.string().nullable().describe("The recipient's bank or mobile-money provider, as free text exactly as the user wrote it (do not correct spelling). Null if not stated. Offramp only."),
  accountIdentifier: z.string().nullable().describe("The recipient's account number or phone number, digits only. Null if not stated. Offramp only."),
  // Onramp fields.
  fiatAmount: z.string().nullable().describe("The fiat amount the user wants to pay in, as a plain string. Null if not stated. Onramp only."),
  fiatCurrency: z.string().nullable().describe("The 3-letter fiat currency code the user is paying in. Null if not stated or unclear. Onramp only."),
  destinationStellarAddress: z.string().nullable().describe("The Stellar G... address that should receive the USDC. Null if not stated. Onramp only."),
  refundInstitutionName: z.string().nullable().describe("The bank the user wants refunded if the fiat payment can't be matched, as free text exactly as written. Null if not stated. Onramp only."),
  refundAccountIdentifier: z.string().nullable().describe("The refund bank account number, digits only. Null if not stated. Onramp only."),
});

export async function POST(request: NextRequest) {
  try {
    const clientKey =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    if (!checkAgentRateLimit(clientKey)) {
      return NextResponse.json(
        { kind: "error", message: "Too many messages — please wait a moment and try again." },
        { status: 429 },
      );
    }

    const body = await request.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    if (messages.length === 0) {
      return NextResponse.json(
        { kind: "error", message: "No conversation to parse" },
        { status: 400 },
      );
    }

    const chains = sourceChainOptions().map((c) => c.code);
    const currencies = await fetchCurrencies();
    const currencyCodes = currencies.map((c) => c.code).join(", ");

    const { object: extraction } = await generateObject({
      model: google(process.env.AGENT_PARSE_MODEL || "gemini-3.5-flash-lite"),
      schema: extractionSchema,
      system:
        `You extract order details from a conversation between a user and ` +
        `Settu's crypto agent. The user wants EITHER to onramp (pay fiat, ` +
        `receive USDC on Stellar) OR offramp (send crypto, receive a fiat ` +
        `payout) — figure out which from context and set "direction" ` +
        `accordingly; only fill in the fields for that direction, leave ` +
        `every field for the other direction null. Only use these source ` +
        `chains for offramp: ${chains.join(", ")}. Only use these currencies ` +
        `for either direction: ${currencyCodes}. ` +
        `Read the WHOLE conversation, not just the latest message — earlier ` +
        `turns may have already supplied fields the latest message doesn't ` +
        `repeat. Never invent a value that wasn't stated or clearly implied.`,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
      })),
    });

    // The model may leave "direction" null on a short/ambiguous first
    // message — fall back to which set of fields it actually populated.
    // Defaults to offramp when both/neither are populated, preserving the
    // existing behavior for a vague opening message.
    const looksOnramp = !!(
      extraction.fiatAmount ||
      extraction.fiatCurrency ||
      extraction.destinationStellarAddress ||
      extraction.refundInstitutionName ||
      extraction.refundAccountIdentifier
    );
    const looksOfframp = !!(
      extraction.amount ||
      extraction.token ||
      extraction.sourceChain ||
      extraction.institutionName ||
      extraction.accountIdentifier
    );
    const direction = extraction.direction ?? (looksOnramp && !looksOfframp ? "onramp" : "offramp");

    if (direction === "onramp") {
      const typedOnrampExtraction: OnrampAgentExtraction = {
        fiatAmount: extraction.fiatAmount,
        fiatCurrency: extraction.fiatCurrency,
        destinationStellarAddress: extraction.destinationStellarAddress,
        refundInstitutionName: extraction.refundInstitutionName,
        refundAccountIdentifier: extraction.refundAccountIdentifier,
      };
      const classifiedOnramp = classifyOnrampExtraction(typedOnrampExtraction);
      if (classifiedOnramp.status === "clarify") {
        return NextResponse.json({ kind: "clarify", message: classifiedOnramp.message });
      }
      if (classifiedOnramp.status === "recap") {
        return NextResponse.json({ kind: "recap", missing: classifiedOnramp.missing });
      }

      const resolvedOnramp = await resolveOnrampOrder(typedOnrampExtraction);
      if (resolvedOnramp.status === "clarify") {
        return NextResponse.json({ kind: "clarify", message: resolvedOnramp.message });
      }
      if (resolvedOnramp.status === "recap") {
        return NextResponse.json({ kind: "recap", missing: resolvedOnramp.missing });
      }

      // No quote to pull here — Paycrest doesn't return a rate until the
      // order actually exists, unlike offramp's pre-fetched quote below.
      return NextResponse.json({ kind: "resolved-onramp", order: resolvedOnramp.order });
    }

    const typedExtraction: AgentOrderExtraction = extraction;
    const classified = classifyExtraction(typedExtraction);
    if (classified.status === "clarify") {
      return NextResponse.json({ kind: "clarify", message: classified.message });
    }
    if (classified.status === "recap") {
      return NextResponse.json({ kind: "recap", missing: classified.missing });
    }

    const resolved = await resolveAgentOrder(typedExtraction);
    if (resolved.status === "clarify") {
      return NextResponse.json({ kind: "clarify", message: resolved.message });
    }
    if (resolved.status === "recap") {
      return NextResponse.json({ kind: "recap", missing: resolved.missing });
    }

    // Pull the live quote now, before the user ever sees a confirmation
    // card — the card must show real numbers (rate, payout), and reusing
    // this exact fetch at confirm time means there's no second, unseen
    // quote the user never agreed to.
    const quoteRes = await fetch(new URL("/api/offramp/quote", request.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: resolved.order.amount,
        amountIn: "crypto",
        token: resolved.order.token,
        currency: resolved.order.beneficiary.currency,
        network: "base",
      }),
    });
    const quotePayload = await quoteRes.json().catch(() => ({}));
    if (!quoteRes.ok) {
      return NextResponse.json({
        kind: "clarify",
        message: quotePayload?.error || "Couldn't get a live rate — please try again in a moment.",
      });
    }

    return NextResponse.json({
      kind: "resolved",
      order: {
        ...resolved.order,
        rate: quotePayload.rate,
        destinationAmount: quotePayload.destinationAmount,
        estimatedTimeMs: quotePayload.estimatedTime,
      },
    });
  } catch (error: any) {
    // The generic message below is what the user sees; log the real cause
    // server-side so a 500 here is diagnosable instead of a dead end.
    console.error("[agent/parse] failed:", error?.message || error, error?.cause || "");
    return NextResponse.json(
      { kind: "error", message: "I had trouble understanding that — please try rephrasing." },
      { status: 500 },
    );
  }
}
