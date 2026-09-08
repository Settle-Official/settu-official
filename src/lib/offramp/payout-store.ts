/**
 * Server-side payout status store, backed by Upstash Redis.
 *
 * This is the source of truth for Paycrest payout status. Paycrest webhook
 * deliveries write here; the SSE stream and status endpoints read from here.
 * (The browser's localStorage remains a client-side history cache only.)
 */

import { Redis } from "@upstash/redis";
import type { PayoutStatus } from "./types";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Beyond Paycrest's 24h webhook retry window, so a late delivery still lands
// on a live key.
const TTL_SECONDS = 48 * 60 * 60;

const key = (orderId: string) => `paycrest:order:${orderId}`;

export interface PayoutRecord {
  status: PayoutStatus;
  amount?: string;
  txHash?: string;
  event?: string;
  updatedAt: number;
}

// Ordering used to reject out-of-order / retried deliveries that would move a
// terminal state backward. Higher = later in the lifecycle.
const STATUS_RANK: Record<PayoutStatus, number> = {
  unknown: 0,
  pending: 1,
  deposited: 2,
  validated: 3,
  settling: 4,
  refunding: 4,
  settled: 5,
  refunded: 5,
  expired: 5,
};

const TERMINAL: ReadonlySet<PayoutStatus> = new Set([
  "settled",
  "refunded",
  "expired",
]);

export function isTerminal(status: PayoutStatus): boolean {
  return TERMINAL.has(status);
}

export async function getPayoutStatus(
  orderId: string,
): Promise<PayoutRecord | null> {
  const record = await redis.get<PayoutRecord>(key(orderId));
  return record ?? null;
}

/**
 * Idempotent write. Paycrest retries deliveries, and they can arrive out of
 * order — never let a later event regress a record that's already terminal or
 * further along. Returns the record now in effect.
 *
 * Merges rather than overwrites: Paycrest doesn't repeat the on-chain txHash
 * (or amount) on every event — it's typically only present on the event that
 * reports the deposit. A later event that omits it would otherwise blank out
 * an already-known value.
 */
export async function setPayoutStatus(
  orderId: string,
  next: Omit<PayoutRecord, "updatedAt">,
): Promise<PayoutRecord> {
  const existing = await getPayoutStatus(orderId);

  if (existing) {
    if (isTerminal(existing.status)) {
      return existing;
    }
    if (STATUS_RANK[next.status] < STATUS_RANK[existing.status]) {
      return existing;
    }
  }

  const record: PayoutRecord = {
    status: next.status,
    amount: next.amount ?? existing?.amount,
    txHash: next.txHash ?? existing?.txHash,
    event: next.event ?? existing?.event,
    updatedAt: Date.now(),
  };
  await redis.set(key(orderId), record, { ex: TTL_SECONDS });
  return record;
}

const settlementRecordedKey = (orderId: string) =>
  `paycrest:order-settlement-recorded:${orderId}`;

/**
 * Atomically claims "this order's completion has been recorded in the
 * transactions feed" — returns true only for the caller that wins the claim.
 *
 * Paycrest can deliver the same webhook more than once in close succession
 * (its own retry, or two near-simultaneous deliveries), and a plain
 * read-then-write check (read prior status, decide, write) isn't atomic: two
 * overlapping requests can both read "not yet recorded" before either has
 * written, and both proceed to push a duplicate transaction. A Redis `SET NX`
 * is atomic across concurrent requests, so only the first one to arrive ever
 * gets `true`.
 *
 * Fires on `validated` (fiat confirmed delivered), not `settled` — see the
 * webhook handler for why.
 */
export async function claimSettlementRecording(
  orderId: string,
): Promise<boolean> {
  const result = await redis.set(settlementRecordedKey(orderId), "1", {
    nx: true,
    ex: TTL_SECONDS,
  });
  return result === "OK";
}
