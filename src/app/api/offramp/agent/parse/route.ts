import { NextRequest, NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { sourceChainOptions } from "@/lib/offramp/source-chain-options";
import { fetchCurrencies } from "@/lib/offramp/paycrest-directory";
import {
  classifyExtraction,
  resolveAgentOrder,
  type AgentOrderExtraction,
} from "@/lib/offramp/agent-resolver";
import { checkAgentRateLimit } from "@/lib/offramp/agent-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const extractionSchema = z.object({
  amount: z.string().nullable().describe("The numeric USDC amount, as a plain string, e.g. \"1000\". Null if not stated."),
  token: z.string().nullable().describe("The token symbol, e.g. \"USDC\". Null if not stated — default to USDC if the user clearly means a stablecoin offramp but didn't name one."),
  sourceChain: z.string().nullable().describe("The lowercase chain key the user is sending from, matching one of the allowed values. Null if not stated or unclear."),
  destinationCurrency: z.string().nullable().describe("The 3-letter fiat currency code the recipient should be paid in, inferred from context (e.g. a Nigerian bank implies NGN) if not stated explicitly. Null only if truly unclear."),
  institutionName: z.string().nullable().describe("The recipient's bank or mobile-money provider, as free text exactly as the user wrote it (do not correct spelling). Null if not stated."),
  accountIdentifier: z.string().nullable().describe("The recipient's account number or phone number, digits only. Null if not stated."),
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
      model: process.env.AGENT_PARSE_MODEL || "anthropic/claude-haiku-4.5",
      schema: extractionSchema,
      system:
        `You extract offramp order details from a conversation between a user ` +
        `and Settu's offramp agent. The user wants to send crypto and have it ` +
        `paid out as fiat. Only use these source chains: ${chains.join(", ")}. ` +
        `Only use these destination currencies: ${currencyCodes}. ` +
        `Read the WHOLE conversation, not just the latest message — earlier ` +
        `turns may have already supplied fields the latest message doesn't ` +
        `repeat. Never invent a value that wasn't stated or clearly implied.`,
      messages: messages.map((m: { role: string; content: string }) => ({
        role: m.role === "agent" ? "assistant" : "user",
        content: m.content,
      })),
    });

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
    return NextResponse.json({ kind: "resolved", order: resolved.order });
  } catch (error: any) {
    return NextResponse.json(
      { kind: "error", message: "I had trouble understanding that — please try rephrasing." },
      { status: 500 },
    );
  }
}
