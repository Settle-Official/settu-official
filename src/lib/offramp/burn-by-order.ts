/**
 * Order id → the burn registered for it.
 *
 * Written by registerOfframpBurn, which every registration path goes
 * through (the page, the burn sweep, the admin console, the status poll), so
 * a page still waiting on its wallet can learn about a burn another path
 * already registered from one cheap read, instead of a chain lookup.
 *
 * Deliberately separate from the transaction history's order index: that
 * record is written fire-and-forget and is skipped entirely when the burn
 * can't be attributed to a sender, and this pointer must not be.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Matches the CCTP transfer record's lifetime.
const TTL_SECONDS = 7 * 24 * 60 * 60;
const KEY = (orderId: string) => `offramp:burn-by-order:${orderId}`;

export async function rememberBurnForOrder(
  orderId: string,
  burnTxHash: string,
): Promise<void> {
  await redis.set(KEY(orderId), burnTxHash, { ex: TTL_SECONDS });
}

export async function getBurnForOrder(orderId: string): Promise<string | null> {
  return (await redis.get<string>(KEY(orderId))) ?? null;
}
