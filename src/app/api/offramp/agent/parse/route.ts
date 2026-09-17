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
import {
  mergeRepeat,
  summarizeOrder,
  type CompletedOrder,
  type PendingOrder,
} from "@/lib/offramp/agent-order-context";

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
  intent: z.enum(["new_or_edit", "status_check", "repeat"]).describe(
    "Classify the LATEST user message. 'status_check' — a PENDING order is " +
      "given in context below and this message is just commenting on, " +
      "confirming payment for, or asking about it, without describing " +
      "something new or different (e.g. \"I've sent the money\", \"any " +
      "update?\", \"done\", \"ok thanks\"). 'repeat' — a COMPLETED order is " +
      "given in context and the user wants to redo it, exactly or with " +
      "changes (e.g. \"do that again\", \"same thing but 200 this time\", " +
      "\"repeat but to my UBA account\") — only fill in the fields the user " +
      "explicitly wants CHANGED, leave the rest null so they carry over. " +
      "'new_or_edit' otherwise: a fresh transaction, or a correction to a " +
      "draft that hasn't been confirmed yet. Default to 'new_or_edit' when unsure.",
  ),
  direction: z.enum(["onramp", "offramp"]).nullable().describe(
    "Whether the user wants to convert fiat to crypto (onramp — they're paying money to receive USDC) or crypto to fiat (offramp — they're sending USDC to receive money in their bank). Null if genuinely ambiguous.",
  ),
  // Offramp fields.
  amount: z.string().nullable().describe("The numeric amount, as a plain string, e.g. \"1000\" — see amountUnit for whether this is USDC or fiat. Null if not stated. Offramp only."),
  amountUnit: z.enum(["crypto", "fiat"]).nullable().describe(
    "OFFRAMP ONLY: whether `amount` is the crypto amount to send (e.g. " +
      "\"offramp 500 USDC\") or the fiat amount the recipient should " +
      "receive (e.g. \"offramp 50000 naira to my GTBank account\", \"send " +
      "my mom ₦20,000\"). Infer \"fiat\" whenever the amount is stated in " +
      "the destination currency — a currency symbol or word (₦, naira, " +
      "NGN, KES, shillings, cedis, etc.) rather than USDC/USDT or a token " +
      "symbol. Null (treated as crypto, the existing default) when genuinely ambiguous.",
  ),
  token: z.string().nullable().describe("The token symbol, e.g. \"USDC\". Null if not stated — default to USDC if the user clearly means a stablecoin offramp but didn't name one. Offramp only."),
  sourceChain: z.string().nullable().describe("The lowercase chain key the user is sending from, matching one of the allowed values. Null if not stated or unclear. Offramp only."),
  destinationCurrency: z.string().nullable().describe("The 3-letter fiat currency code the recipient should be paid in, inferred from context (e.g. a Nigerian bank implies NGN) if not stated explicitly. Null only if truly unclear. Offramp only."),
  institutionName: z.string().nullable().describe("The recipient's bank or mobile-money provider, as free text exactly as the user wrote it (do not correct spelling). Null if not stated. Offramp only."),
  accountIdentifier: z.string().nullable().describe("The recipient's account number or phone number, digits only. Null if not stated. Offramp only."),
  // Onramp fields.
  fiatAmount: z.string().nullable().describe("The fiat amount the user wants to pay in, as a plain string. Null if not stated. Onramp only."),
  fiatCurrency: z.string().nullable().describe("The 3-letter fiat currency code the user is paying in. Null if not stated or unclear. Onramp only."),
  destinationStellarAddress: z.string().nullable().describe("The Stellar G... address that should receive the USDC. If the user refers to their own connected wallet instead of stating an address (e.g. \"my connected wallet\", \"send it to my wallet\"), extract the literal value \"connected\" rather than guessing an address. Null if truly not mentioned. Onramp only."),
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
    // Onramp's destination is always Stellar, so this is specifically the
    // client's connected Stellar Wallets Kit address — supplied by
    // AgentPanel so "my connected wallet" can resolve without the server
    // knowing anything about the browser's wallet state on its own.
    const connectedStellarAddress =
      typeof body?.connectedStellarAddress === "string"
        ? body.connectedStellarAddress
        : null;
    // Both are optional and supplied by AgentPanel from its own message
    // history — see PendingOrder/CompletedOrder above for why the model
    // needs them (telling a status comment apart from a new request, and
    // giving "do that again" something to actually repeat).
    const pendingOrder: PendingOrder | null =
      body?.pendingOrder?.direction === "offramp" || body?.pendingOrder?.direction === "onramp"
        ? body.pendingOrder
        : null;
    const lastCompletedOrder: CompletedOrder | null =
      body?.lastCompletedOrder?.direction === "offramp" || body?.lastCompletedOrder?.direction === "onramp"
        ? body.lastCompletedOrder
        : null;

    const chains = sourceChainOptions().map((c) => c.code);
    const currencies = await fetchCurrencies();
    const currencyCodes = currencies.map((c) => c.code).join(", ");

    let contextNote = "";
    if (pendingOrder) {
      contextNote += ` There is currently a PENDING order awaiting completion — ${summarizeOrder(pendingOrder)}.`;
    }
    if (lastCompletedOrder) {
      contextNote += ` The user's last COMPLETED order was — ${summarizeOrder(lastCompletedOrder)}.`;
    }

    const { object: rawExtraction } = await generateObject({
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
        `repeat. Never invent a value that wasn't stated or clearly implied.` +
        contextNote,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
      })),
    });

    if (rawExtraction.intent === "status_check" && pendingOrder) {
      const message =
        pendingOrder.direction === "onramp"
          ? "Thanks — I'm still watching for that transfer to land. I'll let you know the moment it's confirmed."
          : "Got it — your offramp is still being processed, I'll update you as soon as it's done.";
      return NextResponse.json({ kind: "status", message });
    }

    // "Repeat" only ever restates what the user wants CHANGED (per the
    // schema's instruction to leave everything else null) — fill the rest
    // back in from the last completed order before running the exact same
    // classify/resolve pipeline any other extraction goes through, so a
    // repeat still gets a fresh bank verification and a fresh live quote
    // rather than reusing stale ones.
    const extraction =
      rawExtraction.intent === "repeat" && lastCompletedOrder
        ? mergeRepeat(rawExtraction, lastCompletedOrder)
        : rawExtraction;

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

      const resolvedOnramp = await resolveOnrampOrder(typedOnrampExtraction, {
        connectedStellarAddress,
      });
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
    // quote the user never agreed to. `resolved.order.amount` is still in
    // whatever unit the user stated it in (amountUnit) — the quote route
    // does the reverse solve for fiat mode and always hands back the real
    // USDC figure in `sourceAmount`, exactly like FormCard's amountMode
    // toggle relies on for "enter the naira amount you want to receive".
    const amountIn = extraction.amountUnit ?? "crypto";
    const quoteRes = await fetch(new URL("/api/offramp/quote", request.nextUrl.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: resolved.order.amount,
        amountIn,
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
        // Authoritative regardless of amountUnit — in crypto mode this is
        // just resolved.order.amount reformatted; in fiat mode it's the
        // actual USDC the reverse solve says needs to be burned, which is
        // what confirmOrder/onInitiateOfframp must execute against, never
        // the fiat figure the user typed.
        amount: quotePayload.sourceAmount ?? resolved.order.amount,
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
