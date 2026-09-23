// A WhatsApp message can ask for something; it can never authorise it.
// An intent is a short-lived pointer the user then signs for in the web app.
//
// Cut over to Postgres outright rather than dual-written: single-use must have
// exactly one authority, or a link could be spent in one store and still live
// in the other. The raw token never leaves this process -- the API stores only
// its SHA-256 -- and expiry is enforced in the query, not by eviction.

import { serviceFetch } from "../api/server";

// Creating an intent sits inside Meta's webhook, whose reply carries the link,
// so it cannot be backgrounded.
const TIMEOUT_MS = 8_000;

export interface WalletIntent {
  /** WhatsApp sender, so an intent cannot be redeemed from another thread. */
  phone: string;
  /** Free-form request text, resolved by the agent layer in the web app. */
  request: string;
  createdAt: number;
}

/** URL-safe and long enough that guessing is not a strategy. */
export function generateIntentToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function createIntent(
  phone: string,
  request: string,
): Promise<string> {
  const token = generateIntentToken();
  await serviceFetch("/wallet-intents", {
    method: "POST",
    body: { token, phone, request },
    timeoutMs: TIMEOUT_MS,
  });
  return token;
}

// Single-use is the database's job: DELETE ... RETURNING means a forwarded
// link cannot be redeemed twice, and spent, expired and never-existed all
// come back the same way.
export async function consumeIntent(
  token: string,
): Promise<WalletIntent | null> {
  const { intent } = await serviceFetch<{
    intent: { phone: string; request: string; created_at: number } | null;
  }>("/wallet-intents/consume", {
    method: "POST",
    body: { token },
    timeoutMs: TIMEOUT_MS,
  });

  if (!intent) return null;
  return {
    phone: intent.phone,
    request: intent.request,
    createdAt: intent.created_at,
  };
}
