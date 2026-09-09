/**
 * Permanent, queryable record of every offramp transaction across every
 * source chain -- distinct from CctpTransferRecord (operational, TTL'd,
 * expires once its job is done) and funds-ledger.ts (deliberately only
 * logs entries where the platform itself custodies funds -- offramp
 * entries there carry no wallet, by design). This is the one place with
 * the full picture per transaction, permanently, across every chain.
 */

import { Redis } from "@upstash/redis";
import type { EvmChainKey } from "@/lib/cctp/evm-chains";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ENTRY_KEY = (id: string) => `offramp:tx:${id}`;
const CHRONOLOGICAL_INDEX_KEY = "offramp:tx:index";
const ADDRESS_INDEX_KEY = (address: string) =>
  `offramp:tx:by-address:${address.toLowerCase()}`;

export type OfframpSourceChain = "stellar" | EvmChainKey;

export interface OfframpTransactionRecord {
  id: string; // burn/transfer tx hash -- stable, unique per transaction
  sourceChain: OfframpSourceChain;
  connectedAddress: string;
  amountUsdc: string;
  burnTxHash?: string; // CCTP-bridge chains only
  mintTxHash?: string; // Base-side mint, or Base's own direct-transfer tx hash
  destinationCurrency: string;
  destinationAmount: string;
  paycrestOrderId?: string;
  status: "pending" | "completed" | "failed";
  createdAt: number;
  updatedAt: number;
}

export function buildTransactionRecord(
  fields: Omit<OfframpTransactionRecord, "status" | "createdAt" | "updatedAt"> & {
    status?: OfframpTransactionRecord["status"];
  },
): OfframpTransactionRecord {
  const now = Date.now();
  return {
    ...fields,
    status: fields.status ?? "pending",
    createdAt: now,
    updatedAt: now,
  };
}

export async function recordTransaction(
  fields: Omit<OfframpTransactionRecord, "status" | "createdAt" | "updatedAt"> & {
    status?: OfframpTransactionRecord["status"];
  },
): Promise<OfframpTransactionRecord> {
  const record = buildTransactionRecord(fields);
  await redis.set(ENTRY_KEY(record.id), record); // no `ex` -- permanent
  await redis.zadd(CHRONOLOGICAL_INDEX_KEY, { score: record.createdAt, member: record.id });
  await redis.zadd(ADDRESS_INDEX_KEY(record.connectedAddress), {
    score: record.createdAt,
    member: record.id,
  });
  return record;
}

export async function updateTransactionStatus(
  id: string,
  status: OfframpTransactionRecord["status"],
  patch: Partial<Pick<OfframpTransactionRecord, "mintTxHash" | "paycrestOrderId">> = {},
): Promise<void> {
  const existing = await redis.get<OfframpTransactionRecord>(ENTRY_KEY(id));
  if (!existing) return;
  const updated: OfframpTransactionRecord = {
    ...existing,
    ...patch,
    status,
    updatedAt: Date.now(),
  };
  await redis.set(ENTRY_KEY(id), updated);
}

export async function listByAddress(
  address: string,
  opts: { limit?: number } = {},
): Promise<OfframpTransactionRecord[]> {
  const limit = opts.limit ?? 50;
  const ids = await redis.zrange<string[]>(ADDRESS_INDEX_KEY(address), 0, limit - 1, {
    rev: true,
  });
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<OfframpTransactionRecord>(ENTRY_KEY(id))));
  return records.filter((r): r is OfframpTransactionRecord => r !== null);
}
