import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const TTL_SECONDS = 7 * 24 * 60 * 60;
const key = (id: string) => `cctp:transfer:${id}`;
const PENDING_KEY = "cctp:pending-transfers";
const ADVANCE_LOCK_KEY = (id: string) => `cctp:advance-lock:${id}`;
// Long enough to cover a mint submit + receipt wait on a slow RPC; short
// enough that a crashed process doesn't wedge a transfer indefinitely.
const ADVANCE_LOCK_TTL_SECONDS = 90;

export type CctpStatus =
  | "burned"
  | "attesting"
  | "attested"
  | "minting"
  | "completed"
  | "failed";

export const STATUS_RANK: Record<CctpStatus, number> = {
  burned: 0,
  attesting: 1,
  attested: 2,
  minting: 3,
  completed: 4,
  failed: 4, // terminal, same rank as completed — either ends progression
};

/**
 * Extra data for user-bridge records (direction "bridge"). Atomic amounts are
 * decimal strings in 6-decimal USDC units (records are JSON in Redis).
 */
export interface BridgeMeta {
  source: string;
  dest: string;
  /** Source-chain address that sent the transaction (from the on-chain event). */
  user: string;
  /** Destination recipient: the 0x address for EVM dests, else the mintRecipient bytes32 hex. */
  recipient: string;
  speed: "fast" | "standard";
  quoteNonce: string;
  sendAtomic: string;
  settuFeeAtomic: string;
  networkFeeAtomic: string;
  /** Circle fast-fee cap (maxFee); not emitted on-chain, "0" until the attested message is read. */
  fastFeeMaxAtomic: string;
  receiveMinAtomic: string;
  /** True while receiveMinAtomic is just the burn amount (Fast, maxFee unknown). */
  receiveMinIsBurn?: boolean;
  receivedAtomic?: string;
  attestedAt?: number;
  fellBackToStandard?: boolean;
}

export interface CctpTransferRecord {
  id: string;
  direction: "offramp" | "onramp" | "bridge";
  bridge?: BridgeMeta;
  sourceDomain: number;
  destDomain: number;
  burnTxHash: string;
  mintRecipient: string;
  status: CctpStatus;
  attestationMessage?: string;
  attestationSignature?: string;
  mintTxHash?: string;
  attempts: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  paycrestOrderId?: string;
}

export async function createCctpTransfer(
  record: Omit<CctpTransferRecord, "createdAt" | "updatedAt" | "attempts">,
): Promise<CctpTransferRecord> {
  const now = Date.now();
  const full: CctpTransferRecord = { ...record, attempts: 0, createdAt: now, updatedAt: now };
  await redis.set(key(record.id), full, { ex: TTL_SECONDS });
  await addPendingTransfer(record.id);
  return full;
}

export async function getCctpTransfer(id: string): Promise<CctpTransferRecord | null> {
  return (await redis.get<CctpTransferRecord>(key(id))) ?? null;
}

/**
 * Merge a patch onto the existing record. Terminal records (completed/failed)
 * are frozen — once a transfer reaches a final state, no later write can
 * regress it. This is the guard that was missing when a stale, racing
 * "attested" read's failure write overwrote an already-successful "minting"
 * status; the accompanying advance lock (see acquireAdvanceLock) closes the
 * race itself, this is the belt-and-suspenders backstop in case two advances
 * ever run concurrently anyway (e.g. the lock expired mid-flight).
 */
export function mergeCctpTransfer(
  existing: CctpTransferRecord,
  patch: Partial<Omit<CctpTransferRecord, "id" | "createdAt">>,
): CctpTransferRecord {
  if (existing.status === "completed" || existing.status === "failed") {
    return existing;
  }
  return {
    ...existing,
    ...patch,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
}

export async function updateCctpTransfer(
  id: string,
  patch: Partial<Omit<CctpTransferRecord, "id" | "createdAt">>,
): Promise<CctpTransferRecord | null> {
  const existing = await getCctpTransfer(id);
  if (!existing) return null;

  const merged = mergeCctpTransfer(existing, patch);
  await redis.set(key(id), merged, { ex: TTL_SECONDS });
  if (merged.status === "completed" || merged.status === "failed") {
    await removePendingTransfer(id);
  }
  return merged;
}

/**
 * Single-flight lock so only one advanceCctpTransfer call is ever actively
 * working a given transfer at a time. A caller that fails to acquire it
 * should just read the current status and do nothing — whichever call holds
 * the lock will finish and update the record; the next tick picks it up.
 * Auto-expires so a crashed/timed-out process can't wedge a transfer.
 */
/**
 * Pure transition for reviveCctpTransfer below — kept separate so the
 * decision of "what state to resume from" is unit-testable without Redis.
 * Resumes from wherever the record already got to: a valid attestation
 * means retry the mint, otherwise start over from fetching one. Only
 * meaningful for a `failed` record; returns it unchanged otherwise (the
 * caller uses that to report "nothing to revive").
 */
export function computeRevivedTransfer(
  existing: CctpTransferRecord,
): CctpTransferRecord {
  if (existing.status !== "failed") return existing;
  const resumeStatus: CctpStatus =
    existing.attestationMessage && existing.attestationSignature
      ? "attested"
      : "burned";
  const { lastError: _lastError, ...rest } = existing;
  return { ...rest, status: resumeStatus, attempts: 0, updatedAt: Date.now() };
}

/**
 * Escape hatch for a transfer wrongly frozen `failed` — e.g. it exhausted
 * MAX_ATTEMPTS against an operational problem (a missing hot-wallet secret,
 * an unfunded gas floor) rather than a genuine on-chain failure. The normal
 * update path (updateCctpTransfer/mergeCctpTransfer) refuses on purpose to
 * touch a terminal record — that guard is what closed the original race-
 * condition incident — so reviving one is a deliberate, explicit write that
 * bypasses it, not something day-to-day code can trigger by accident.
 *
 * Returns `revived: false` (record left untouched) if it isn't currently
 * `failed` — this is not a general-purpose status editor.
 */
export async function reviveCctpTransfer(
  id: string,
): Promise<{ revived: boolean; record: CctpTransferRecord } | null> {
  const existing = await getCctpTransfer(id);
  if (!existing) return null;
  if (existing.status !== "failed") {
    return { revived: false, record: existing };
  }

  const revived = computeRevivedTransfer(existing);
  await redis.set(key(id), revived, { ex: TTL_SECONDS });
  await addPendingTransfer(id);
  return { revived: true, record: revived };
}

export async function acquireAdvanceLock(id: string): Promise<boolean> {
  const result = await redis.set(ADVANCE_LOCK_KEY(id), "1", {
    nx: true,
    ex: ADVANCE_LOCK_TTL_SECONDS,
  });
  return result === "OK";
}

export async function releaseAdvanceLock(id: string): Promise<void> {
  await redis.del(ADVANCE_LOCK_KEY(id));
}

export async function addPendingTransfer(id: string): Promise<void> {
  await redis.sadd(PENDING_KEY, id);
}

export async function removePendingTransfer(id: string): Promise<void> {
  await redis.srem(PENDING_KEY, id);
}

export async function listPendingTransfers(): Promise<string[]> {
  return (await redis.smembers(PENDING_KEY)) ?? [];
}
