/**
 * Which notifications a wallet has read, server-side.
 *
 * The notifications themselves are derived from data that already lives on
 * the server (the permanent offramp record), so only the read state needed
 * somewhere shared — without it, reading something on a laptop left it
 * showing unread on a phone.
 *
 * A sorted set rather than a plain set: the score is when the id was marked,
 * which is what lets the store be trimmed to the most recent entries instead
 * of growing forever.
 *
 * Deliberately keyed by wallet address, with no auth, matching the existing
 * /api/history/[address] route this sits next to. That is the same trust
 * model rather than a new one: read state is not funds, and the endpoint can
 * only ever mark a notification seen. Worth revisiting together with that
 * route if the app ever requires login.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const READ_KEY = (address: string) => `notif:read:${address.toLowerCase()}`;

// Notifications are derived from a capped history read, so the live set is
// far smaller than this. The cap exists so a long-lived wallet can't grow an
// unbounded key, not because it's expected to be reached.
const MAX_IDS = 1000;

/** Rejects anything that isn't plausibly a wallet address. */
export function isValidAddress(address: string | undefined): address is string {
  return typeof address === "string" && address.length >= 8 && address.length <= 128;
}

export async function getReadIds(address: string): Promise<string[]> {
  return (await redis.zrange<string[]>(READ_KEY(address), 0, -1)) ?? [];
}

/**
 * Adds ids to the read set. Additive on purpose — two devices marking
 * different notifications read must not overwrite each other, which is
 * exactly what sending a whole replacement list would do.
 */
export async function addReadIds(address: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  const key = READ_KEY(address);
  // Split off the first pair: zadd's signature requires at least one, so a
  // bare spread doesn't satisfy it.
  const [first, ...rest] = ids.map((id, i) => ({ score: now + i, member: id }));
  await redis.zadd(key, first, ...rest);
  // Keep the newest MAX_IDS. Negative indexes count from the end, so this
  // drops everything older than that window.
  await redis.zremrangebyrank(key, 0, -MAX_IDS - 1);
}

/** Marks everything unread again by dropping the whole set. */
export async function clearReadIds(address: string): Promise<void> {
  await redis.del(READ_KEY(address));
}
