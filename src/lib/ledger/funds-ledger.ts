/**
 * Permanent audit log of real fund movements into wallets this platform
 * controls — separate from operational bridge-state records (which are
 * ephemeral and expire). This is a financial record meant to accumulate, so
 * entries have NO TTL, unlike every other Redis record in this codebase.
 */

import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";
import type { OfframpSourceChain } from "@/lib/offramp/transaction-history";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ENTRY_KEY = (id: string) => `ledger:entry:${id}`;
const INDEX_KEY = "ledger:index"; // sorted set, score = recordedAt

export interface FundsLedgerEntry {
  id: string;
  direction: "onramp" | "offramp";
  /** Only set when funds actually land in a wallet we control. */
  wallet?: "base_hot_wallet" | "stellar_hot_wallet";
  // "base" kept explicitly for onramp's own base_hot_wallet entries;
  // OfframpSourceChain covers "stellar" + every EVM offramp source chain.
  chain: "base" | OfframpSourceChain;
  asset: "USDC";
  amount: string;
  txHash: string;
  orderId?: string;
  recordedAt: number;
}

export function buildLedgerEntry(
  fields: Omit<FundsLedgerEntry, "id" | "recordedAt">,
): FundsLedgerEntry {
  return { ...fields, id: randomUUID(), recordedAt: Date.now() };
}

export async function recordLedgerEntry(
  fields: Omit<FundsLedgerEntry, "id" | "recordedAt">,
): Promise<FundsLedgerEntry> {
  const entry = buildLedgerEntry(fields);
  await redis.set(ENTRY_KEY(entry.id), entry); // no `ex` — permanent
  await redis.zadd(INDEX_KEY, { score: entry.recordedAt, member: entry.id });
  return entry;
}

export async function listLedgerEntries(
  opts: { limit?: number } = {},
): Promise<FundsLedgerEntry[]> {
  const limit = opts.limit ?? 100;
  const ids = await redis.zrange<string[]>(INDEX_KEY, 0, limit - 1, {
    rev: true,
  });
  if (ids.length === 0) return [];
  const entries = await Promise.all(
    ids.map((id) => redis.get<FundsLedgerEntry>(ENTRY_KEY(id))),
  );
  return entries.filter((e): e is FundsLedgerEntry => e !== null);
}
