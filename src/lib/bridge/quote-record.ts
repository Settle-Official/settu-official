/**
 * What a signed quote promised, keyed by its nonce, so registration can
 * recover the exact recipient and minimum receive that the on-chain event
 * does not carry. Best-effort: writers must tolerate failure.
 */

import { Redis } from "@upstash/redis";

export interface QuoteRecord {
  source: string;
  dest: string;
  speed: "fast" | "standard";
  /** Source-chain address that was quoted. */
  user: string;
  /** User-entered destination address in native form (0x, G or base58 wallet). */
  recipient: string;
  /** 6-decimal USDC atomic, decimal string. */
  maxFeeAtomic: string;
  /** 6-decimal USDC atomic, decimal string (the breakdown's receiveAtomic). */
  receiveMinAtomic: string;
}

export const QUOTE_RECORD_TTL_SECONDS = 2 * 24 * 60 * 60;
const key = (nonce: string) => `bridge:quote:${nonce.toLowerCase()}`;

let redis: Redis | null = null;
function getRedis(): Redis {
  redis ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  return redis;
}

export async function saveQuoteRecord(nonce: string, rec: QuoteRecord): Promise<void> {
  await getRedis().set(key(nonce), rec, { ex: QUOTE_RECORD_TTL_SECONDS });
}

export async function loadQuoteRecord(nonce: string): Promise<QuoteRecord | null> {
  return (await getRedis().get<QuoteRecord>(key(nonce))) ?? null;
}
