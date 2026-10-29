/**
 * Server-side offramp order metadata, backed by Upstash Redis.
 *
 * The Paycrest webhook payload only carries id/status/amount — not the bank
 * details, rate, or payout value. Those are known only at order-creation time,
 * so we stash them here keyed by order id and re-read them when enriching
 * webhook alerts. Kept beyond the webhook retry window.
 */

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const TTL_SECONDS = 48 * 60 * 60;
const key = (orderId: string) => `paycrest:order-meta:${orderId}`;
/**
 * Order ids scored by creation time, so the burn sweep can read just the
 * window it cares about. It used to SCAN the whole database for meta keys
 * every 5 minutes, which costs a command per 200 keys of EVERY kind, and
 * was most of what ran the Upstash quota out on 2026-10-29.
 */
// Outside the `paycrest:order-meta:` prefix so a scan for meta keys never
// mistakes either of these for an order.
const INDEX_KEY = "paycrest:order-meta-index";
const BACKFILLED_KEY = "paycrest:order-meta-index:backfilled";

export interface OrderMeta {
  institution: string; // bank code (e.g. GTBINGLA)
  accountIdentifier: string;
  accountName: string;
  currency: string; // fiat, e.g. NGN
  amountUsdc: number;
  rate: number;
  payoutValue: number; // fiat value the recipient receives
  reference?: string;
  network?: string;
  /**
   * Which chain the user burned/transferred USDC from — "stellar" | an EVM
   * chain key | "solana". Recorded so webhook alerts (whose payload lacks it)
   * can show the source.
   */
  sourceChain?: string;
  /**
   * Paycrest's per-order deposit address — the CCTP burn's mintRecipient.
   * Stashed so a stuck/expired order can be diagnosed straight from our own
   * store instead of re-fetching it from Paycrest's API, and so a burn found
   * on-chain with no matching CctpTransferRecord can be matched back to an
   * order by address.
   */
  receiveAddress?: string;
  /**
   * The wallet the user burned/transferred USDC FROM (Stellar G-address, EVM
   * 0x-address, or Solana base58). Recorded so the burn-backstop sweep can
   * scan that account's on-chain history for a `deposit_for_burn` whose
   * client-side registration never landed (a burn that confirmed on-chain but
   * whose `register-transfer` call was lost strands the funds — the mint
   * recipient is fixed at burn time and nothing else will ever mint it).
   */
  senderAddress?: string;
  /**
   * The provider queue this order was routed to, best-rate first, and where the
   * rate came from. Kept for support triage: a settlement that went wrong is
   * much easier to chase when you know which providers were in play and whether
   * the rate was book-derived or taken from the client's quote.
   */
  providerIds?: string[];
  rateSource?: "book" | "client";
  createdAt: number;
}

export async function setOrderMeta(
  orderId: string,
  meta: Omit<OrderMeta, "createdAt">,
): Promise<void> {
  const record: OrderMeta = { ...meta, createdAt: Date.now() };
  await redis.set(key(orderId), record, { ex: TTL_SECONDS });
  await redis.zadd(INDEX_KEY, { score: record.createdAt, member: orderId });
  // Entries outlive their meta keys otherwise; trim on write, which is
  // already per order, rather than adding work to the sweep.
  await redis.zremrangebyscore(INDEX_KEY, 0, record.createdAt - TTL_SECONDS * 1000);
}

export async function getOrderMeta(
  orderId: string,
): Promise<OrderMeta | null> {
  const meta = await redis.get<OrderMeta>(key(orderId));
  return meta ?? null;
}

/**
 * Metadata for every order created between `from` and `to` (epoch ms).
 * Used by the burn-backstop sweep — it can't rely on `paycrest:payout:*` keys
 * because those only exist once a webhook or poll has set a payout status,
 * and a fully-stranded burn's order may never have reached that point.
 *
 * Two commands however many orders there are: a range read of the index and
 * one MGET. Orders written before the index existed are picked up once by
 * `backfillIndex` the first time it finds the index missing.
 */
export async function listOrderMetasCreatedBetween(
  from: number,
  to: number,
): Promise<{ orderId: string; meta: OrderMeta }[]> {
  await ensureIndexed();
  const ids = await redis.zrange<string[]>(INDEX_KEY, from, to, { byScore: true });
  if (ids.length === 0) return [];
  const metas = await redis.mget<(OrderMeta | null)[]>(...ids.map(key));
  return ids.flatMap((orderId, i) => {
    const meta = metas[i];
    return meta ? [{ orderId, meta }] : [];
  });
}

/** All order ids that still have metadata (created within the last 48h). */
export async function listOrderMetaIds(): Promise<string[]> {
  await ensureIndexed();
  // The index is only trimmed on write, so bound it to the meta keys' TTL.
  return redis.zrange<string[]>(INDEX_KEY, Date.now() - TTL_SECONDS * 1000, "+inf", {
    byScore: true,
  });
}

/**
 * One-off: index the meta keys that predate the index. Keyed on a marker
 * rather than on the index existing, since the index is legitimately empty
 * after a quiet 48h and that must not trigger a full scan on every sweep.
 */
async function ensureIndexed(): Promise<void> {
  if (await redis.exists(BACKFILLED_KEY)) return;
  const prefix = key("");
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: `${prefix}*`,
      count: 1000,
    });
    cursor = next;
    if (batch.length === 0) continue;
    const metas = await redis.mget<(OrderMeta | null)[]>(...batch);
    const members = batch.flatMap((k, i) => {
      const meta = metas[i];
      return meta ? [{ score: meta.createdAt, member: k.slice(prefix.length) }] : [];
    });
    if (members.length > 0) {
      const [first, ...rest] = members;
      await redis.zadd(INDEX_KEY, first, ...rest);
    }
  } while (cursor !== "0");
  await redis.set(BACKFILLED_KEY, Date.now());
}
