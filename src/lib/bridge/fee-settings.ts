import { Redis } from "@upstash/redis";

export const DEFAULT_BRIDGE_FEE_BPS = 50;
export const DEFAULT_FEE_CAP_BPS = 100;

const FEE_KEY = "bridge:fee-bps";
const AUDIT_KEY = "bridge:fee-bps:audit";
const AUDIT_MAX = 200;

let redis: Redis | null = null;
function getRedis(): Redis {
  redis ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  return redis;
}

/** Returns an error message for an invalid fee, or null when it is acceptable. */
export function validateFeeBps(bps: number, lowestCapBps: number): string | null {
  if (Number.isNaN(bps)) return "Fee must be a number.";
  if (!Number.isInteger(bps)) return "Fee must be whole basis points.";
  if (bps < 0) return "Fee cannot be negative.";
  if (bps > lowestCapBps) {
    return `Fee cannot exceed the ${lowestCapBps} bps cap.`;
  }
  return null;
}

export async function getBridgeFeeBps(): Promise<number> {
  const stored = await getRedis().get<number | string>(FEE_KEY);
  return stored == null ? DEFAULT_BRIDGE_FEE_BPS : Number(stored);
}

export async function setBridgeFeeBps(
  bps: number,
  actor: string,
  lowestCapBps: number,
): Promise<void> {
  const error = validateFeeBps(bps, lowestCapBps);
  if (error) throw new Error(error);

  const from = await getBridgeFeeBps();
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    actor,
    from,
    to: bps,
  });

  await getRedis()
    .multi()
    .set(FEE_KEY, bps)
    .lpush(AUDIT_KEY, entry)
    .ltrim(AUDIT_KEY, 0, AUDIT_MAX - 1)
    .exec();
}
