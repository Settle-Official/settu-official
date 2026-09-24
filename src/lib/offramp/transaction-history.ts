/**
 * Permanent, queryable record of every offramp transaction across every
 * source chain -- distinct from CctpTransferRecord (operational, TTL'd) and
 * funds-ledger.ts (only where the platform itself custodies funds).
 *
 * Mid-migration: writes go to Redis (authoritative) and then Postgres. Reads
 * flip once the backfill has run; the Redis leg goes in phase two.
 */

import { Redis } from "@upstash/redis";
import { serviceWrite } from "../api/server";
import type { EvmChainKey } from "@/lib/cctp/evm-chains";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const ENTRY_KEY = (id: string) => `offramp:tx:${id}`;
const CHRONOLOGICAL_INDEX_KEY = "offramp:tx:index";
const ADDRESS_INDEX_KEY = (address: string) =>
  `offramp:tx:by-address:${address.toLowerCase()}`;
// Settlement arrives from Paycrest keyed by order id, while a record is keyed
// by its burn/transfer hash. This index is what makes that a single O(1) read
// instead of a scan over every transaction ever made.
const ORDER_INDEX_KEY = (orderId: string) => `offramp:tx:by-order:${orderId}`;

export type OfframpSourceChain = "stellar" | EvmChainKey | "solana";

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

/** Snake-case wire shape. Exported so the round trip can be tested. */
export interface TransactionWire {
  id: string;
  source_chain: string;
  connected_address: string;
  amount_usdc: string;
  burn_tx_hash?: string;
  mint_tx_hash?: string;
  destination_currency: string;
  destination_amount: string;
  paycrest_order_id?: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export function toWire(record: OfframpTransactionRecord): TransactionWire {
  return {
    id: record.id,
    source_chain: record.sourceChain,
    connected_address: record.connectedAddress,
    amount_usdc: record.amountUsdc,
    ...(record.burnTxHash ? { burn_tx_hash: record.burnTxHash } : {}),
    ...(record.mintTxHash ? { mint_tx_hash: record.mintTxHash } : {}),
    destination_currency: record.destinationCurrency,
    // The API validates this as a decimal; "" and undefined both mean zero.
    destination_amount: record.destinationAmount || "0",
    ...(record.paycrestOrderId ? { paycrest_order_id: record.paycrestOrderId } : {}),
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function fromWire(wire: TransactionWire): OfframpTransactionRecord {
  return {
    id: wire.id,
    sourceChain: wire.source_chain as OfframpSourceChain,
    connectedAddress: wire.connected_address,
    amountUsdc: wire.amount_usdc,
    ...(wire.burn_tx_hash ? { burnTxHash: wire.burn_tx_hash } : {}),
    ...(wire.mint_tx_hash ? { mintTxHash: wire.mint_tx_hash } : {}),
    destinationCurrency: wire.destination_currency,
    destinationAmount: wire.destination_amount,
    ...(wire.paycrest_order_id ? { paycrestOrderId: wire.paycrest_order_id } : {}),
    status: wire.status as OfframpTransactionRecord["status"],
    createdAt: wire.created_at,
    updatedAt: wire.updated_at,
  };
}

// base-direct-register awaits this and 500s on failure, with the user's
// transfer already settled on Base. The second leg must stay tight.
const WRITE_TIMEOUT_MS = 2_500;
const PATCH_TIMEOUT_MS = 8_000;

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
  if (record.paycrestOrderId) {
    await redis.set(ORDER_INDEX_KEY(record.paycrestOrderId), record.id);
  }
  // Second leg. Redis stays authoritative until the read flips, and the
  // backfill repairs whatever a sleeping backend drops here.
  await serviceWrite("/offramp/transactions", toWire(record), WRITE_TIMEOUT_MS);
  return record;
}

/**
 * Resolve the record id behind a Paycrest order id.
 *
 * Normally one index read. Records written before that index existed fall
 * back to a bounded walk of the newest transactions, and the index is
 * backfilled on a hit so any given old order pays that cost at most once.
 * The walk is capped rather than exhaustive: settlement webhooks arrive
 * within minutes of the burn, so a matching order is always near the head.
 */
async function resolveIdByOrder(orderId: string): Promise<string | null> {
  const indexed = await redis.get<string>(ORDER_INDEX_KEY(orderId));
  if (indexed) return indexed;

  const ids = await redis.zrange<string[]>(CHRONOLOGICAL_INDEX_KEY, 0, 199, { rev: true });
  if (ids.length === 0) return null;
  const records = await Promise.all(ids.map((id) => redis.get<OfframpTransactionRecord>(ENTRY_KEY(id))));
  const hit = records.find((r) => r?.paycrestOrderId === orderId);
  if (!hit) return null;

  await redis.set(ORDER_INDEX_KEY(orderId), hit.id);
  return hit.id;
}

/**
 * Apply a settlement outcome to the permanent record, addressed the way
 * Paycrest addresses it — by order id.
 *
 * This is what keeps the record honest after creation. Without it a bridged
 * offramp stays "pending" forever and a Base-direct one claims "completed"
 * from the moment it was registered, neither of which reflects whether the
 * recipient was actually paid. `destinationAmount` is filled in here too:
 * register-burn writes "0" because the payout isn't known yet at burn time.
 *
 * No-ops when the order has no record (an order created before this store
 * existed), so it is safe to call on every webhook.
 */
export async function updateTransactionByOrderId(
  orderId: string,
  status: OfframpTransactionRecord["status"],
  patch: Partial<Pick<OfframpTransactionRecord, "mintTxHash" | "destinationAmount">> = {},
): Promise<void> {
  // Postgres leg first and unconditionally: it addresses the row by order id
  // directly, so it does not need the Redis index, and its no-regress guard
  // lives in the WHERE clause rather than in a racing read-then-write.
  await serviceWrite(
    `/offramp/transactions/by-order/${encodeURIComponent(orderId)}`,
    { status, ...toPatchWire(patch) },
    PATCH_TIMEOUT_MS,
    "PATCH",
  );

  const id = await resolveIdByOrder(orderId);
  if (!id) return;

  const existing = await redis.get<OfframpTransactionRecord>(ENTRY_KEY(id));
  if (!existing) return;

  // Never walk a settled record back to pending. Paycrest redelivers webhooks
  // and can deliver them out of order, so a late "deposited" must not undo a
  // "completed" that already landed.
  if (existing.status === "completed" && status !== "failed") return;

  await redis.set(ENTRY_KEY(id), {
    ...existing,
    ...patch,
    status,
    updatedAt: Date.now(),
  } satisfies OfframpTransactionRecord);
}

// Only send keys that carry a value: the API COALESCEs absent ones, so an
// explicit null would wipe a hash or payout figure written earlier.
function toPatchWire(
  patch: Partial<
    Pick<
      OfframpTransactionRecord,
      "mintTxHash" | "destinationAmount" | "paycrestOrderId"
    >
  >,
): Record<string, string> {
  return {
    ...(patch.mintTxHash ? { mint_tx_hash: patch.mintTxHash } : {}),
    ...(patch.destinationAmount
      ? { destination_amount: patch.destinationAmount }
      : {}),
    ...(patch.paycrestOrderId
      ? { paycrest_order_id: patch.paycrestOrderId }
      : {}),
  };
}

export async function updateTransactionStatus(
  id: string,
  status: OfframpTransactionRecord["status"],
  patch: Partial<Pick<OfframpTransactionRecord, "mintTxHash" | "paycrestOrderId">> = {},
): Promise<void> {
  await serviceWrite(
    `/offramp/transactions/${encodeURIComponent(id)}`,
    { status, ...toPatchWire(patch) },
    PATCH_TIMEOUT_MS,
    "PATCH",
  );

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

/**
 * A page of records, newest first. For admin reconciliation over the whole
 * store — `listByAddress` answers the per-user question, this one walks
 * everything without loading it all into memory at once.
 */
export async function listAllPaged(
  offset: number,
  limit: number,
): Promise<OfframpTransactionRecord[]> {
  const ids = await redis.zrange<string[]>(
    CHRONOLOGICAL_INDEX_KEY,
    offset,
    offset + limit - 1,
    { rev: true },
  );
  if (ids.length === 0) return [];
  const records = await Promise.all(ids.map((id) => redis.get<OfframpTransactionRecord>(ENTRY_KEY(id))));
  return records.filter((r): r is OfframpTransactionRecord => r !== null);
}

/**
 * Write the by-order index for a record that predates it, so the next
 * settlement for that order resolves in one read instead of a walk.
 */
export async function indexExistingOrder(record: OfframpTransactionRecord): Promise<void> {
  if (!record.paycrestOrderId) return;
  await redis.set(ORDER_INDEX_KEY(record.paycrestOrderId), record.id);
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
