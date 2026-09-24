/**
 * One-off, idempotent: index every onramp order still in Redis that reached
 * `delivered`, so the landing page's transfer count includes it.
 *
 * The permanent index (onramp:delivered) is written at delivery, but only by
 * code that has it — deliveries made before that shipped live only in the
 * per-order records, which expire after 7 days. Run this once when the
 * change deploys (and it is safe to re-run: it's a sorted set keyed by order
 * id). Anything that expired before it runs is gone for good.
 *
 *   node --env-file=.env.local --import ./scripts/register-ts-resolver.mjs \
 *     scripts/backfill-onramp-delivered.ts
 */
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

interface OrderRecord {
  orderId: string;
  status: string;
  updatedAt: number;
}

let cursor = "0";
let seen = 0;
const delivered: OrderRecord[] = [];
do {
  const [next, keys] = await redis.scan(cursor, { match: "onramp:order:*", count: 200 });
  cursor = String(next);
  if (keys.length) {
    const records = await redis.mget<(OrderRecord | null)[]>(...keys);
    for (const r of records) {
      if (!r) continue;
      seen += 1;
      if (r.status === "delivered") delivered.push(r);
    }
  }
} while (cursor !== "0");

for (const r of delivered) {
  // updatedAt is when it reached delivered — terminal records are frozen.
  await redis.zadd("onramp:delivered", { score: r.updatedAt, member: r.orderId });
}
const total = await redis.zcard("onramp:delivered");
console.log(`onramp orders in Redis: ${seen}, delivered: ${delivered.length}, index now holds: ${total}`);
