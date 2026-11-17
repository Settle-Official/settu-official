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
  /** Destination wallet address (exact when the quote record was found); absent when unknown (Stellar dest, no quote record). */
  recipient?: string;
  /** recipient is a Solana token account (ATA), not the wallet. */
  recipientIsTokenAccount?: boolean;
  recipientUnknown?: boolean;
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
  /** Native-token fee paid on the source chain (from the on-chain event); absent on older records. */
  nativeFeeAtomic?: string;
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
  if (record.direction === "bridge") {
    // One MULTI: the record, its pending entry and its explorer-index entry
    // land together or not at all, so a failed index write can't orphan it.
    const tx = redis.multi();
    tx.set(key(record.id), full, { ex: TTL_SECONDS });
    tx.sadd(PENDING_KEY, record.id);
    tx.zadd(BRIDGE_INDEX_KEY, { score: full.createdAt, member: record.id });
    tx.zremrangebyscore(BRIDGE_INDEX_KEY, "-inf", `(${indexCutoff(full.createdAt)}`);
    await tx.exec();
    return full;
  }
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

// ---- bridge explorer index (admin) ----------------------------------------

const BRIDGE_INDEX_KEY = "bridge:index";
/** Index entries older than the record TTL point at expired records; trimmed on every write. */
export const INDEX_TRIM_MS = TTL_SECONDS * 1000;
const indexCutoff = (now: number) => now - INDEX_TRIM_MS;

/**
 * Idempotent: (re)adds `id` to bridge:index and trims entries older than 7
 * days (`ZREMRANGEBYSCORE bridge:index -inf (now-7d`). Called by the sweep's
 * advance pass so a bridge whose index write was ever lost reappears.
 */
export async function indexBridgeTransfer(id: string, createdAt: number, now: number = Date.now()): Promise<void> {
  const tx = redis.multi();
  tx.zadd(BRIDGE_INDEX_KEY, { score: createdAt, member: id });
  tx.zremrangebyscore(BRIDGE_INDEX_KEY, "-inf", `(${indexCutoff(now)}`);
  await tx.exec();
}

/**
 * One page of the index, newest first: ids with score in [min, max]
 * (`max` may be "(123" for exclusive, "+inf" for none). One ZREVRANGEBYSCORE.
 */
export async function rangeBridgeIndex(max: string, min: string, count: number): Promise<string[]> {
  return (
    (await redis.zrange<string[]>(BRIDGE_INDEX_KEY, max as `(${number}` | "+inf", min as `(${number}` | "-inf", {
      byScore: true,
      rev: true,
      offset: 0,
      count,
    })) ?? []
  );
}

/** One MGET for many records (missing/expired come back null). */
export async function getCctpTransfers(ids: string[]): Promise<(CctpTransferRecord | null)[]> {
  if (ids.length === 0) return [];
  const rows = await redis.mget<(CctpTransferRecord | null)[]>(...ids.map(key));
  return rows.map((r) => r ?? null);
}
