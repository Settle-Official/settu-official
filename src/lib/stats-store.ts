import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const SEED_USERS = parseInt(process.env.STATS_SEED_USERS || "120", 10);
const SEED_VOLUME = parseFloat(process.env.STATS_SEED_VOLUME || "48000");
// Historical baselines, reconciled from the Paycrest sender-orders export
// (2026-02-17 to 2026-09-19): 296 settled orders worth ₦16,926,377. The
// counters below start from zero and only ever count settlements from the
// day they shipped, so adding the export's totals as a floor is what makes
// the published figure the real lifetime number rather than "since we
// happened to start counting".
const SEED_TRANSACTIONS = parseInt(process.env.STATS_SEED_TRANSACTIONS || "296", 10);
const SEED_VOLUME_NGN = parseFloat(process.env.STATS_SEED_VOLUME_NGN || "16926377");

const KEYS = {
  users: "stellaramp:total_users",
  volume: "stellaramp:total_volume",
  wallets: "stellaramp:known_wallets",
  recentTransactions: "stellaramp:recent_transactions",
  transactions: "stellaramp:total_transactions",
  volumeNgn: "stellaramp:total_volume_ngn",
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
  /** Lifetime settled payouts, in the destination fiat (NGN). */
  totalVolumeNgn: number;
  /** Lifetime count of settled transactions. */
  totalTransactions: number;
  recentTransactions: RecentTransactionEntry[];
}> {
  const [users, volume, volumeNgn, txCount, transactions] = await Promise.all([
    getNumber(KEYS.users),
    getNumber(KEYS.volume),
    getNumber(KEYS.volumeNgn),
    getNumber(KEYS.transactions),
    redis.lrange<RecentTransactionEntry>(KEYS.recentTransactions, 0, 49),
  ]);
  return {
    totalUsers: users + SEED_USERS,
    totalVolume: volume + SEED_VOLUME,
    totalVolumeNgn: volumeNgn + SEED_VOLUME_NGN,
    totalTransactions: txCount + SEED_TRANSACTIONS,
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

/**
 * Records one settled transaction and the fiat that actually landed.
 *
 * The fiat is accumulated at settlement, when the payout is known, rather
 * than converting a USDC total at display time — the rate moves, so
 * converting historical volume at today's rate would quietly misstate it.
 */
export async function recordSettledTransaction(payoutFiat?: number): Promise<void> {
  await redis.incr(KEYS.transactions);
  if (typeof payoutFiat === "number" && Number.isFinite(payoutFiat) && payoutFiat > 0) {
    await redis.incrbyfloat(KEYS.volumeNgn, payoutFiat);
  }
}

export async function pushRecentTransaction(entry: RecentTransactionEntry): Promise<void> {
  await redis.lpush(KEYS.recentTransactions, entry);
  await redis.ltrim(KEYS.recentTransactions, 0, 49); // keep last 50
}
