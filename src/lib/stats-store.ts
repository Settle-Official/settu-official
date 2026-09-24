import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const SEED_USERS = parseInt(process.env.STATS_SEED_USERS || "120", 10);
const SEED_VOLUME = parseFloat(process.env.STATS_SEED_VOLUME || "48000");

const KEYS = {
  users: "stellaramp:total_users",
  volume: "stellaramp:total_volume",
  wallets: "stellaramp:known_wallets",
  recentTransactions: "stellaramp:recent_transactions",
};

export interface RecentTransactionEntry {
  txHash: string;
  usdc: string;
  naira: string;
  status: "SETTLING" | "COMPLETE";
  type: "onramp" | "offramp";
}

/**
 * Reads a numeric key from Redis as a guaranteed `number`.
 *
 * `redis.get<number>(...)` is a lie: counters written with `incr`/`incrbyfloat`
 * come back as strings at runtime, so doing arithmetic on the raw value
 * silently string-concatenates instead of adding. This coerces and guards
 * against missing/NaN values, returning `fallback` (default 0) when absent.
 */
async function getNumber(key: string, fallback = 0): Promise<number> {
  const raw = await redis.get<number | string | null>(key);
  const value = Number(raw ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

export async function getStats(): Promise<{
  totalUsers: number;
  totalVolume: number;
  recentTransactions: RecentTransactionEntry[];
}> {
  const [users, volume, transactions] = await Promise.all([
    getNumber(KEYS.users),
    getNumber(KEYS.volume),
    redis.lrange<RecentTransactionEntry>(KEYS.recentTransactions, 0, 49),
  ]);
  return {
    totalUsers: users + SEED_USERS,
    totalVolume: volume + SEED_VOLUME,
    recentTransactions: transactions ?? [],
  };
}

/** Returns true if this is a new (first-time) wallet */
export async function trackWallet(address: string): Promise<boolean> {
  const isNew = await redis.sadd(KEYS.wallets, address);
  if (isNew) {
    await redis.incr(KEYS.users);
  }
  return isNew === 1;
}

export async function addVolume(amount: number): Promise<void> {
  await redis.incrbyfloat(KEYS.volume, amount);
}

export async function pushRecentTransaction(entry: RecentTransactionEntry): Promise<void> {
  await redis.lpush(KEYS.recentTransactions, entry);
  await redis.ltrim(KEYS.recentTransactions, 0, 49); // keep last 50
}
