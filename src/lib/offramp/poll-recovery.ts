/**
 * Rate limiter for recovery attempts driven by the client's status poll.
 *
 * The poll runs every few seconds while a user watches their transfer. The
 * recovery check behind it costs a Horizon or RPC call plus an Iris lookup,
 * so it must not run on every poll — but it does need to run soon enough
 * that nobody waits meaningfully.
 *
 * Redis SET NX with a TTL: the first poll in each window claims the attempt,
 * the rest are no-ops. Also means two tabs, or two instances, can't stampede
 * the same order.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Long enough to be cheap, short enough that a stranded burn is caught while
// the user is still looking at the screen.
const WINDOW_SECONDS = 45;

export async function claimPollRecovery(orderId: string): Promise<boolean> {
  try {
    const claimed = await redis.set(`offramp:poll-recover:${orderId}`, "1", {
      nx: true,
      ex: WINDOW_SECONDS,
    });
    return claimed === "OK";
  } catch {
    // Redis unreachable — skip the attempt rather than hammering the chain.
    return false;
  }
}
