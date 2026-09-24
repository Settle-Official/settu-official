/**
 * Permanent audit log of real fund movements into wallets this platform
 * controls — separate from operational bridge-state records, which expire.
 *
 * Mid-migration: writes go to Redis (authoritative) and then Postgres, while
 * reads already come from Postgres. The Redis leg goes in phase two.
 */

import { Redis } from "@upstash/redis";
import { randomUUID } from "crypto";
import { serviceFetch, serviceWrite } from "../api/server";
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

/** Snake-case wire shape. Exported so the round trip can be tested. */
export interface LedgerEntryWire {
  id: string;
  direction: string;
  wallet?: string;
  chain: string;
  asset: string;
  amount: string;
  tx_hash: string;
  order_id?: string;
  recorded_at: number;
}

export function toWire(entry: FundsLedgerEntry): LedgerEntryWire {
  return {
    id: entry.id,
    direction: entry.direction,
    ...(entry.wallet ? { wallet: entry.wallet } : {}),
    chain: entry.chain,
    asset: entry.asset,
    amount: entry.amount,
    tx_hash: entry.txHash,
    ...(entry.orderId ? { order_id: entry.orderId } : {}),
    recorded_at: entry.recordedAt,
  };
}

export function fromWire(wire: LedgerEntryWire): FundsLedgerEntry {
  return {
    id: wire.id,
    direction: wire.direction as FundsLedgerEntry["direction"],
    ...(wire.wallet ? { wallet: wire.wallet as FundsLedgerEntry["wallet"] } : {}),
    chain: wire.chain as FundsLedgerEntry["chain"],
    asset: wire.asset as FundsLedgerEntry["asset"],
    amount: wire.amount,
    txHash: wire.tx_hash,
    ...(wire.order_id ? { orderId: wire.order_id } : {}),
    recordedAt: wire.recorded_at,
  };
}

// Awaited on the burn-registration path, so the Postgres leg is tight and
// swallowed: it must never delay or fail a burn that already landed on-chain.
const WRITE_TIMEOUT_MS = 2_500;

export async function recordLedgerEntry(
  fields: Omit<FundsLedgerEntry, "id" | "recordedAt">,
): Promise<FundsLedgerEntry> {
  const entry = buildLedgerEntry(fields);
  await redis.set(ENTRY_KEY(entry.id), entry); // no `ex` — permanent
  await redis.zadd(INDEX_KEY, { score: entry.recordedAt, member: entry.id });
  // Second leg. Redis stays authoritative until the read flips, and the
  // backfill repairs whatever a sleeping backend drops here.
  await serviceWrite("/ledger/entries", toWire(entry), WRITE_TIMEOUT_MS);
  return entry;
}

// Reads Postgres, not Redis: one indexed query instead of a ZRANGE plus an
// N+1 fan-out. Full history needs the backfill to have run.
export async function listLedgerEntries(
  opts: { limit?: number; offset?: number } = {},
): Promise<FundsLedgerEntry[]> {
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const { entries } = await serviceFetch<{ entries: LedgerEntryWire[] }>(
    `/ledger/entries?limit=${limit}&offset=${offset}`,
  );
  return entries.map(fromWire);
}
