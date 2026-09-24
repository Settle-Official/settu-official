// Mid-migration: writes go to Redis (authoritative) and then Postgres, while
// reads prefer Postgres and fall back to Redis. The Redis leg goes in phase two.

import { Redis } from "@upstash/redis";
import { serviceFetch, serviceWrite } from "./api/server";

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

interface RawStats {
  users: number;
  volume: number;
  transactions: RecentTransactionEntry[];
}

// Short: six places on the dashboard await this, so a sleeping backend must
// fall through to Redis quickly rather than hold the page.
const READ_TIMEOUT_MS = 2_500;

async function fromApi(): Promise<RawStats> {
  const data = await serviceFetch<{
    total_users: number;
    total_volume: string;
    recent_transactions: {
      tx_hash: string;
      usdc: string;
      naira: string;
      status: RecentTransactionEntry["status"];
      type: RecentTransactionEntry["type"];
    }[];
  }>("/stats", { timeoutMs: READ_TIMEOUT_MS });

  return {
    users: Number(data.total_users) || 0,
    // numeric::text arrives as a string, same coercion trap getNumber guards.
    volume: Number(data.total_volume) || 0,
    transactions: data.recent_transactions.map((t) => ({
      txHash: t.tx_hash,
      usdc: t.usdc,
      naira: t.naira,
      status: t.status,
      type: t.type,
    })),
  };
}

async function fromRedis(): Promise<RawStats> {
  const [users, volume, transactions] = await Promise.all([
    getNumber(KEYS.users),
    getNumber(KEYS.volume),
    redis.lrange<RecentTransactionEntry>(KEYS.recentTransactions, 0, 49),
  ]);
  return { users, volume, transactions: transactions ?? [] };
}

export async function getStats(): Promise<{
  totalUsers: number;
  totalVolume: number;
  recentTransactions: RecentTransactionEntry[];
}> {
  const raw = (await fromApi().catch(() => null)) ?? (await fromRedis());
  // Display offsets, applied in one place for both paths so the two are
  // indistinguishable to the UI. The API returns true counts on purpose:
  // reconciliation and admin views must never have to subtract a seed.
  return {
    totalUsers: raw.users + SEED_USERS,
    totalVolume: raw.volume + SEED_VOLUME,
    recentTransactions: raw.transactions,
  };
}

// Nothing waits on these: they are called from webhook and settlement paths
// that have already moved the money.
const WRITE_TIMEOUT_MS = 8_000;

/** Returns true if this is a new (first-time) wallet */
export async function trackWallet(address: string): Promise<boolean> {
  const isNew = await redis.sadd(KEYS.wallets, address);
  if (isNew) {
    await redis.incr(KEYS.users);
  }
  // Postgres validates the address and may disagree about newness while the
  // two stores differ; Redis decides until the read flips, so the caller sees
  // one consistent answer throughout the migration.
  await serviceWrite("/stats/wallets", { address }, WRITE_TIMEOUT_MS);
  return isNew === 1;
}

export async function addVolume(amount: number): Promise<void> {
  await redis.incrbyfloat(KEYS.volume, amount);
  // String, not number: the API takes a decimal and toFixed avoids handing it
  // exponential notation for very small or very large values.
  await serviceWrite(
    "/stats/volume",
    { amount: amount.toFixed(6) },
    WRITE_TIMEOUT_MS,
  );
}

/** Only `txHash` differs from the wire shape; the rest already match. */
export function feedEntryToWire(entry: RecentTransactionEntry) {
  return {
    tx_hash: entry.txHash,
    usdc: entry.usdc,
    naira: entry.naira,
    status: entry.status,
    type: entry.type,
  };
}

export async function pushRecentTransaction(entry: RecentTransactionEntry): Promise<void> {
  await redis.lpush(KEYS.recentTransactions, entry);
  await redis.ltrim(KEYS.recentTransactions, 0, 49); // keep last 50
  await serviceWrite(
    "/stats/transactions",
    feedEntryToWire(entry),
    WRITE_TIMEOUT_MS,
  );
}
