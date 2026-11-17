import { Redis } from "@upstash/redis";
import type { Speed } from "./quote-math";

export const DEFAULT_BRIDGE_FEE_BPS = { standard: 30, fast: 60 } as const;
export const DEFAULT_FEE_CAP_BPS = 100;

const feeKey = (speed: Speed) => `bridge:fee-bps:${speed}`;
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

export type FeeReader = (key: string) => Promise<unknown>;
const defaultRedisRead: FeeReader = (key) =>
  getRedis().get<number | string>(key);

/** Returns an error message for an invalid fee, or null when it is acceptable. */
export function validateFeeBps(bps: number, lowestCapBps: number): string | null {
  if (!Number.isFinite(lowestCapBps) || lowestCapBps < 0) {
    return "Fee cap is invalid.";
  }
  if (Number.isNaN(bps)) return "Fee must be a number.";
  if (!Number.isInteger(bps)) return "Fee must be whole basis points.";
  if (bps < 0) return "Fee cannot be negative.";
  if (bps > lowestCapBps) {
    return `Fee cannot exceed the ${lowestCapBps} bps cap.`;
  }
  return null;
}

/** A stored value counts only if it is an integer in [0, 10000]; else the default. */
export function parseStoredFeeBps(raw: unknown, speed: Speed): number {
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+$/.test(raw))) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 10000) return n;
  }
  return DEFAULT_BRIDGE_FEE_BPS[speed];
}

export async function getBridgeFeeBps(
  speed: Speed,
  read: FeeReader = defaultRedisRead,
): Promise<number> {
  return parseStoredFeeBps(await read(feeKey(speed)), speed);
}

export async function setBridgeFeeBps(
  speed: Speed,
  bps: number,
  actor: string,
  lowestCapBps: number,
): Promise<void> {
  const error = validateFeeBps(bps, lowestCapBps);
  if (error) throw new Error(error);

  const from = await getBridgeFeeBps(speed);
  const entry = JSON.stringify({
    at: new Date().toISOString(),
    actor,
    speed,
    from,
    to: bps,
  });

  await getRedis()
    .multi()
    .set(feeKey(speed), bps)
    .lpush(AUDIT_KEY, entry)
    .ltrim(AUDIT_KEY, 0, AUDIT_MAX - 1)
    .exec();
}

export interface FeeAuditEntry {
  at: string;
  actor: string;
  speed: Speed;
  from: number;
  to: number;
}

/** Newest first. Entries are JSON strings (Upstash may hand back parsed objects). */
export async function listBridgeFeeAudit(limit = 20): Promise<FeeAuditEntry[]> {
  const raw = await getRedis().lrange<string | FeeAuditEntry>(AUDIT_KEY, 0, limit - 1);
  return (raw ?? []).flatMap((r) => {
    if (typeof r !== "string") return r && typeof r === "object" ? [r] : [];
    try {
      return [JSON.parse(r) as FeeAuditEntry];
    } catch {
      return [];
    }
  });
}
