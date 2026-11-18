/**
 * The permanent record of completed bridges.
 *
 * A bridge's working record (`cctp:transfer:<id>`) expires after 7 days, so
 * nothing lasting can be read from it. When a bridge completes, one entry is
 * written here with no expiry, indexed by completion time and by the sender's
 * and recipient's addresses. It backs bridges in History and the "USDC
 * bridged" landing figure, which reads these entries rather than a counter,
 * in the same spirit as landing-stats.ts: what counts is what's recorded.
 *
 * Keys:
 *   bridge:done:<id>                  JSON CompletedBridge (SET NX: idempotent)
 *   bridge:done:index                 zset, score = completedAt
 *   bridge:done:by-address:<addr>     zset per sender/recipient, score = completedAt
 */

import { Redis } from "@upstash/redis";
import type { CctpTransferRecord } from "../cctp/cctp-store";

export interface CompletedBridge {
  id: string;
  source: string;
  dest: string;
  user: string;
  recipient?: string;
  speed: string;
  /** USDC the user sent, 6-dp atomic. */
  sendAtomic: string;
  settuFeeAtomic: string;
  /** USDC that arrived, 6-dp atomic (the promised minimum if it wasn't read). */
  receivedAtomic: string;
  sourceTx: string;
  destTx?: string;
  createdAt: number;
  completedAt: number;
}

/** The five Redis operations the ledger needs (injectable for tests). */
export interface LedgerStore {
  setNx(key: string, value: string): Promise<boolean>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrevrange(key: string, start: number, stop: number): Promise<string[]>;
  mget(keys: string[]): Promise<(string | CompletedBridge | null)[]>;
}

const ENTRY = (id: string) => `bridge:done:${id}`;
const INDEX = "bridge:done:index";
const PAGE = 200;

/** EVM addresses are case-insensitive; Stellar and base58 Solana addresses are not. */
export function addressKey(address: string): string {
  const a = address.trim();
  return `bridge:done:by-address:${/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a}`;
}

export function completedBridgeEntry(r: CctpTransferRecord, now: number): CompletedBridge | null {
  const m = r.bridge;
  if (r.direction !== "bridge" || r.status !== "completed" || !m) return null;
  return {
    id: r.id,
    source: m.source,
    dest: m.dest,
    user: m.user,
    ...(m.recipient !== undefined ? { recipient: m.recipient } : {}),
    speed: m.speed,
    sendAtomic: m.sendAtomic,
    settuFeeAtomic: m.settuFeeAtomic,
    receivedAtomic: m.receivedAtomic ?? m.receiveMinAtomic,
    sourceTx: r.burnTxHash,
    ...(r.mintTxHash ? { destTx: r.mintTxHash } : {}),
    createdAt: r.createdAt,
    completedAt: now,
  };
}

/** Writes the entry once; returns false when it was already recorded. */
export async function recordCompletedBridge(
  r: CctpTransferRecord,
  store: LedgerStore = defaultLedgerStore(),
  now: number = Date.now(),
): Promise<boolean> {
  const e = completedBridgeEntry(r, now);
  if (!e) return false;
  if (!(await store.setNx(ENTRY(e.id), JSON.stringify(e)))) return false;
  const keys = new Set([addressKey(e.user), ...(e.recipient ? [addressKey(e.recipient)] : [])]);
  await Promise.all([
    store.zadd(INDEX, e.completedAt, e.id),
    ...[...keys].map((k) => store.zadd(k, e.completedAt, e.id)),
  ]);
  return true;
}

function parse(v: string | CompletedBridge | null): CompletedBridge | null {
  if (!v) return null;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as CompletedBridge;
  } catch {
    return null;
  }
}

async function entries(ids: string[], store: LedgerStore): Promise<CompletedBridge[]> {
  if (!ids.length) return [];
  return (await store.mget(ids.map(ENTRY))).map(parse).filter((e): e is CompletedBridge => !!e);
}

/** Newest first: bridges this address sent or received. */
export async function listCompletedBridgesByAddress(
  address: string,
  limit = 100,
  store: LedgerStore = defaultLedgerStore(),
): Promise<CompletedBridge[]> {
  return entries(await store.zrevrange(addressKey(address), 0, Math.max(0, limit - 1)), store);
}

/** Lifetime count and USDC sent across every completed bridge. */
export async function bridgeLifetimeTotals(
  store: LedgerStore = defaultLedgerStore(),
): Promise<{ count: number; sentAtomic: bigint }> {
  let count = 0;
  let sentAtomic = BigInt(0);
  for (let start = 0; ; start += PAGE) {
    const ids = await store.zrevrange(INDEX, start, start + PAGE - 1);
    for (const e of await entries(ids, store)) {
      count++;
      if (/^\d+$/.test(e.sendAtomic)) sentAtomic += BigInt(e.sendAtomic);
    }
    if (ids.length < PAGE) break;
  }
  return { count, sentAtomic };
}

let client: Redis | null = null;

export function defaultLedgerStore(): LedgerStore {
  client ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
  const r = client;
  return {
    setNx: async (key, value) => (await r.set(key, value, { nx: true })) === "OK",
    zadd: (key, score, member) => r.zadd(key, { score, member }),
    zrevrange: (key, start, stop) => r.zrange<string[]>(key, start, stop, { rev: true }),
    mget: (keys) => r.mget<(string | CompletedBridge | null)[]>(...keys),
  };
}
