// A WhatsApp message can ask for something; it can never authorise it.
// An intent is a short-lived pointer the user then signs for in the web app.

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Long enough to switch apps and sign, short enough that a leaked link in a
// chat backup is worthless later.
const TTL_SECONDS = 15 * 60;

const key = (token: string) => `wallet:intent:${token}`;

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
  const intent: WalletIntent = { phone, request, createdAt: Date.now() };
  await redis.set(key(token), intent, { ex: TTL_SECONDS });
  return token;
}

// Read and delete in one step, so a link works once even if forwarded.
export async function consumeIntent(
  token: string,
): Promise<WalletIntent | null> {
  const raw = await redis.getdel(key(token));
  if (!raw) return null;
  return typeof raw === "string"
    ? (JSON.parse(raw) as WalletIntent)
    : (raw as WalletIntent);
}
