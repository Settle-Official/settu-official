/**
 * Server-side onramp order store, backed by Upstash Redis.
 *
 * Source of truth for onramp (fiat → USDC on Stellar). Holds the mapping from
 * a Paycrest order to the user's Stellar address plus the state of the
 * Base→Stellar bridge leg. Because onramp is custodial between fiat settlement
 * and Stellar delivery, every transition is persisted so a crash or timeout
 * never loses track of held funds.
 */

import { Redis } from "@upstash/redis";
import type { OnrampStatus } from "../offramp/types";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Keep well beyond Paycrest's 24h retry window; held funds may take a while to
// resolve manually.
const TTL_SECONDS = 7 * 24 * 60 * 60;

const key = (orderId: string) => `onramp:order:${orderId}`;
const deliveryRecordedKey = (orderId: string) =>
  `onramp:delivery-recorded:${orderId}`;

export interface OnrampRecord {
  orderId: string;
  userStellarAddress: string;
  fiatAmount: string;
  currency: string;
  status: OnrampStatus;
  // Refund account details (for alert enrichment; the webhook payload lacks them)
  refundInstitution?: string;
  refundAccountIdentifier?: string;
  refundAccountName?: string;
  rate?: number;
  baseUsdcAmount?: string; // amount that landed in the hot wallet
  bridgeTxHash?: string; // Base-side CCTP burn tx
  stellarTxHash?: string; // Stellar delivery tx (if known)
  cctpTransferId?: string; // links to the CctpTransferRecord driving delivery
  failureReason?: string;
  bridgeStartedAt?: number; // when the Base→Stellar bridge was broadcast
  staleAlerted?: boolean; // finalizer already sent the "slow to confirm" alert
  updatedAt: number;
}

// Set of orders whose Base→Stellar bridge is in flight. The finalizer cron
// scans this instead of every Redis key. Members are removed once the order
// reaches a terminal state.
const PENDING_BRIDGES_KEY = "onramp:pending-bridges";

// Lifecycle ordering — prevents a retried/out-of-order event from regressing a
// record. Bridge states rank above Paycrest's `settled` since they come after.
const STATUS_RANK: Record<OnrampStatus, number> = {
  unknown: 0,
  pending: 1,
  deposited: 2,
  validated: 3,
  settling: 4,
  settled: 5,
  bridging: 6,
  delivered: 7,
  bridge_failed: 7,
  refunding: 7,
  refunded: 8,
  expired: 8,
};

const TERMINAL: ReadonlySet<OnrampStatus> = new Set([
  "delivered",
  "refunded",
  "expired",
]);

// bridge_failed is "sticky" but NOT terminal — it holds funds pending manual
// resolution, after which it can move to delivered or refunded.
export function isTerminal(status: OnrampStatus): boolean {
  return TERMINAL.has(status);
}

export async function getOnrampOrder(
  orderId: string,
): Promise<OnrampRecord | null> {
  const record = await redis.get<OnrampRecord>(key(orderId));
  return record ?? null;
}

/**
 * Create the initial record when an order is placed. Overwrites any stale key
 * for the same id (order ids are unique per creation).
 */
export async function createOnrampOrder(
  record: Omit<OnrampRecord, "updatedAt">,
): Promise<OnrampRecord> {
  const full: OnrampRecord = { ...record, updatedAt: Date.now() };
  await redis.set(key(record.orderId), full, { ex: TTL_SECONDS });
  return full;
}

/**
 * Merge an update into an existing record. Idempotent and no-regress: a status
 * that ranks lower than the current one is ignored (other fields still merge),
 * and terminal records are frozen. Returns the record now in effect.
 */
export async function updateOnrampOrder(
  orderId: string,
  patch: Partial<Omit<OnrampRecord, "orderId" | "updatedAt">>,
): Promise<OnrampRecord | null> {
  const existing = await getOnrampOrder(orderId);
  if (!existing) return null;

  if (isTerminal(existing.status)) {
    return existing;
  }

  let nextStatus = existing.status;
  if (patch.status && STATUS_RANK[patch.status] >= STATUS_RANK[existing.status]) {
    nextStatus = patch.status;
  }

  const merged: OnrampRecord = {
    ...existing,
    ...patch,
    status: nextStatus,
    orderId: existing.orderId,
    updatedAt: Date.now(),
  };

  await redis.set(key(orderId), merged, { ex: TTL_SECONDS });
  return merged;
}

/**
 * Best-effort single-flight lock so concurrent webhook retries can't trigger
 * the Base→Stellar bridge twice for the same order. Returns true if the caller
 * acquired the lock. Auto-expires so a crashed handler can't wedge an order.
 */
// Atomic SET NX so the three paths that detect a delivery can't double-count it.
export async function claimOnrampDeliveryRecording(
  orderId: string,
): Promise<boolean> {
  const result = await redis.set(deliveryRecordedKey(orderId), "1", {
    nx: true,
    ex: TTL_SECONDS,
  });
  return result === "OK";
}

export async function acquireBridgeLock(orderId: string): Promise<boolean> {
  const result = await redis.set(`onramp:bridge-lock:${orderId}`, "1", {
    nx: true,
    ex: 300, // 5 min — long enough for approval + broadcast
  });
  return result === "OK";
}

export async function releaseBridgeLock(orderId: string): Promise<void> {
  await redis.del(`onramp:bridge-lock:${orderId}`);
}

/**
 * Force a `bridge_failed` order back to `settled` so a manual retry can
 * re-enter the bridging pipeline. Needed because updateOnrampOrder's
 * no-regress guard otherwise blocks bridge_failed (rank 7) -> bridging
 * (rank 6). No-op if the order isn't currently bridge_failed.
 */
export async function resetBridgeFailedForRetry(
  orderId: string,
): Promise<OnrampRecord | null> {
  const existing = await getOnrampOrder(orderId);
  if (!existing || existing.status !== "bridge_failed") return existing;

  const reset: OnrampRecord = {
    ...existing,
    status: "settled",
    failureReason: undefined,
    staleAlerted: undefined,
    updatedAt: Date.now(),
  };
  await redis.set(key(orderId), reset, { ex: TTL_SECONDS });
  return reset;
}

/**
 * Force a `bridge_failed` order back to `bridging` WITHOUT re-triggering a
 * new burn — for when the underlying CCTP transfer already burned
 * successfully (see reviveCctpTransfer in cctp-store.ts) and just needs its
 * mint step resumed. Using resetBridgeFailedForRetry here instead would
 * re-enter handleOnrampSettled and burn the same settled USDC a second time.
 * No-op if the order isn't bridge_failed or has no cctpTransferId to resume.
 */
export async function resumeBridgingForRetry(
  orderId: string,
): Promise<OnrampRecord | null> {
  const existing = await getOnrampOrder(orderId);
  if (!existing || existing.status !== "bridge_failed" || !existing.cctpTransferId) {
    return existing;
  }
  const resumed: OnrampRecord = {
    ...existing,
    status: "bridging",
    failureReason: undefined,
    staleAlerted: undefined,
    updatedAt: Date.now(),
  };
  await redis.set(key(orderId), resumed, { ex: TTL_SECONDS });
  await addPendingBridge(orderId);
  return resumed;
}

// --- Pending-bridge tracking (for the finalizer cron) ----------------------

/** Mark an order's bridge as in flight so the finalizer cron will watch it. */
export async function addPendingBridge(orderId: string): Promise<void> {
  await redis.sadd(PENDING_BRIDGES_KEY, orderId);
}

/** Remove an order from the finalizer's watch set (terminal or handed off). */
export async function removePendingBridge(orderId: string): Promise<void> {
  await redis.srem(PENDING_BRIDGES_KEY, orderId);
}

/** All order ids with an in-flight Base→Stellar bridge. */
export async function listPendingBridges(): Promise<string[]> {
  return (await redis.smembers(PENDING_BRIDGES_KEY)) ?? [];
}
