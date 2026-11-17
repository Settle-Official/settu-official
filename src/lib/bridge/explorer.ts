/**
 * Admin bridge explorer: an indexer-style view over every bridge record.
 *
 * Redis cost is the design constraint (the project has hit its Upstash quota):
 *  - the index is a sorted set `bridge:index` (score = createdAt, member = id),
 *    written once per record in bridge-store;
 *  - an unfiltered list page is ONE ZREVRANGEBYSCORE + ONE MGET; with a filter
 *    or q it scans pages of 100, at most LIST_SCAN_CAP (500) records = 10 commands;
 *  - totals walk the window in MGET pages of <= 100 and stop at
 *    TOTALS_SCAN_CAP (2,000) records scanned per call (`truncated: true` when
 *    hit), and are cached in-memory for 30 s per process;
 *  - never SCAN.
 *
 * Records expire after 7 days but index members do not; expired members just
 * MGET as null and are skipped. Bridges created before this index existed are
 * not listed. Cursor = createdAt of the last row returned (exclusive), so two
 * bridges created in the same millisecond can straddle a page boundary.
 */

import {
  getCctpTransfers,
  rangeBridgeIndex,
  type CctpTransferRecord,
} from "../cctp/cctp-store";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";
import { toStatusView, type BridgeStatusView } from "./bridge-store";

export const STUCK_AFTER_MS = 30 * 60 * 1000;
export const MGET_PAGE = 100;
/** Scan cap when a filter or q is active (5 rounds of 100 = 10 Redis commands). */
export const LIST_SCAN_CAP = 500;
export const TOTALS_SCAN_CAP = 2_000;
export const TOTALS_CACHE_MS = 30_000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

const WINDOW_MS = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000 } as const;
export type TotalsWindow = keyof typeof WINDOW_MS;

export type ExplorerRow = BridgeStatusView & {
  createdAt: number;
  updatedAt: number;
  user: string;
  speed: "fast" | "standard";
  settuFeeAtomic: string;
  networkFeeAtomic: string;
  nativeFeeAtomic: string;
  receiveMinIsBurn?: boolean;
  attempts: number;
  recordStatus: CctpTransferRecord["status"];
  attestedAt?: number;
  lastError?: string;
  stuck: boolean;
  /** Display data resolved server-side (the chain registry reads server env). */
  sourceLabel: string;
  destLabel: string;
  nativeSymbol: string;
  nativeDecimals: number;
  sourceTxUrl?: string;
  destTxUrl?: string;
};

export interface ExplorerFilters {
  cursor?: string;
  limit?: number;
  /** A view status, or "stuck". */
  status?: string;
  source?: string;
  dest?: string;
  speed?: "fast" | "standard";
  /** createdAt bounds, epoch ms, inclusive. */
  from?: number;
  to?: number;
  /** Source tx hash, user or recipient address: exact or prefix, case-insensitive. */
  q?: string;
}

export interface ExplorerTotals {
  count: number;
  volumeAtomic: string;
  /** Settu fee + network fee (USDC); the native fee is a different asset. */
  feesAtomic: string;
  inProgress: number;
  failedOrStuck: number;
  /** The scan cap was hit: figures cover only the newest TOTALS_SCAN_CAP bridges. */
  truncated: boolean;
}

export interface ExplorerDeps {
  now(): number;
  /** ZREVRANGEBYSCORE max min LIMIT 0 count → ids, newest first. */
  range(max: string, min: string, count: number): Promise<string[]>;
  mget(ids: string[]): Promise<(CctpTransferRecord | null)[]>;
  /** In-memory totals cache; omit to disable. */
  cache?: Map<string, { at: number; value: ExplorerTotals }>;
}

const totalsCache = new Map<string, { at: number; value: ExplorerTotals }>();

const defaultDeps: ExplorerDeps = {
  now: Date.now,
  range: rangeBridgeIndex,
  mget: getCctpTransfers,
  cache: totalsCache,
};

export function toExplorerRow(r: CctpTransferRecord, now: number): ExplorerRow {
  const view = toStatusView(r, now);
  const m = r.bridge!;
  const src = BRIDGE_CHAINS[m.source as BridgeChainKey] as (typeof BRIDGE_CHAINS)[BridgeChainKey] | undefined;
  const dst = BRIDGE_CHAINS[m.dest as BridgeChainKey] as (typeof BRIDGE_CHAINS)[BridgeChainKey] | undefined;
  const final = r.status === "completed" || r.status === "failed";
  return {
    ...view,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    user: m.user,
    speed: m.speed,
    settuFeeAtomic: m.settuFeeAtomic,
    networkFeeAtomic: m.networkFeeAtomic,
    nativeFeeAtomic: m.nativeFeeAtomic ?? "0",
    ...(m.receiveMinIsBurn ? { receiveMinIsBurn: true } : {}),
    attempts: r.attempts,
    recordStatus: r.status,
    ...(m.attestedAt !== undefined ? { attestedAt: m.attestedAt } : {}),
    ...(r.lastError ? { lastError: r.lastError } : {}),
    stuck: !final && now - r.updatedAt > STUCK_AFTER_MS,
    sourceLabel: src?.label ?? m.source,
    destLabel: dst?.label ?? m.dest,
    nativeSymbol: src?.nativeSymbol ?? "",
    nativeDecimals: src?.family === "stellar" ? 7 : src?.family === "solana" ? 9 : 18,
    ...(src ? { sourceTxUrl: src.explorerTx(r.burnTxHash) } : {}),
    ...(src && dst && r.mintTxHash ? { destTxUrl: dst.explorerTx(r.mintTxHash) } : {}),
  };
}

function matches(row: ExplorerRow, f: ExplorerFilters, q: string): boolean {
  if (f.status && (f.status === "stuck" ? !row.stuck : row.status !== f.status)) return false;
  if (f.source && row.source !== f.source) return false;
  if (f.dest && row.dest !== f.dest) return false;
  if (f.speed && row.speed !== f.speed) return false;
  if (q) {
    const hay = [row.id, row.sourceTx, row.destTx, row.user, row.recipient];
    if (!hay.some((h) => h && h.toLowerCase().startsWith(q))) return false;
  }
  return true;
}

export async function listBridges(
  f: ExplorerFilters = {},
  deps: ExplorerDeps = defaultDeps,
): Promise<{ rows: ExplorerRow[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(Math.trunc(f.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const now = deps.now();
  const min = f.from !== undefined ? String(f.from) : "-inf";
  const q = f.q?.trim().toLowerCase() ?? "";
  // Filters discard rows, so scan in full pages of 100; an unfiltered page is exactly `limit`.
  const filtered = !!(f.status || f.source || f.dest || f.speed || q);
  const pageSize = filtered ? MGET_PAGE : Math.min(limit, MGET_PAGE);
  const scanCap = LIST_SCAN_CAP;
  let max = f.cursor ? `(${f.cursor}` : f.to !== undefined ? String(f.to) : "+inf";
  if (f.cursor && f.to !== undefined && Number(f.cursor) > f.to + 1) max = String(f.to);

  const rows: ExplorerRow[] = [];
  let scanned = 0;
  let lastScore: number | undefined;
  let more = false;

  while (rows.length < limit && scanned < scanCap) {
    const ids = await deps.range(max, min, pageSize);
    if (ids.length === 0) break;
    scanned += ids.length;
    const recs = await deps.mget(ids);
    for (const r of recs) {
      if (!r || r.direction !== "bridge" || !r.bridge) continue;
      lastScore = r.createdAt;
      const row = toExplorerRow(r, now);
      if (matches(row, f, q)) {
        rows.push(row);
        if (rows.length >= limit) break;
      }
    }
    if (rows.length >= limit) {
      more = true;
      break;
    }
    if (ids.length < pageSize) break;
    if (lastScore === undefined) break;
    max = `(${lastScore}`;
    more = true; // cap may stop us before the index is exhausted
  }
  if (rows.length < limit && scanned < scanCap) more = false;

  const cursorScore = rows.length >= limit ? rows[rows.length - 1].createdAt : lastScore;
  return {
    rows,
    ...(more && cursorScore !== undefined ? { nextCursor: String(cursorScore) } : {}),
  };
}

export async function bridgeTotals(
  window: TotalsWindow,
  deps: ExplorerDeps = defaultDeps,
): Promise<ExplorerTotals> {
  const now = deps.now();
  const hit = deps.cache?.get(window);
  if (hit && now - hit.at < TOTALS_CACHE_MS) return hit.value;

  const since = String(now - WINDOW_MS[window]);
  let volume = BigInt(0);
  let fees = BigInt(0);
  let count = 0;
  let inProgress = 0;
  let failedOrStuck = 0;
  let scanned = 0;
  let truncated = false;
  let max = "+inf";

  while (scanned < TOTALS_SCAN_CAP) {
    const size = Math.min(MGET_PAGE, TOTALS_SCAN_CAP - scanned);
    const ids = await deps.range(max, since, size);
    if (ids.length === 0) break;
    scanned += ids.length;
    const recs = await deps.mget(ids);
    let last: number | undefined;
    for (const r of recs) {
      if (!r || r.direction !== "bridge" || !r.bridge) continue;
      last = r.createdAt;
      const row = toExplorerRow(r, now);
      count++;
      volume += BigInt(row.sendAtomic);
      fees += BigInt(row.settuFeeAtomic) + BigInt(row.networkFeeAtomic);
      if (row.status === "failed" || row.stuck) failedOrStuck++;
      else if (row.status !== "completed") inProgress++;
    }
    if (ids.length < size) break;
    if (last === undefined) break;
    max = `(${last}`;
    if (scanned >= TOTALS_SCAN_CAP) truncated = true;
  }

  const value: ExplorerTotals = {
    count,
    volumeAtomic: volume.toString(),
    feesAtomic: fees.toString(),
    inProgress,
    failedOrStuck,
    truncated,
  };
  deps.cache?.set(window, { at: now, value });
  return value;
}
