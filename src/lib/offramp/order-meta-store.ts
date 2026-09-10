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
}

export async function getOrderMeta(
  orderId: string,
): Promise<OrderMeta | null> {
  const meta = await redis.get<OrderMeta>(key(orderId));
  return meta ?? null;
}

/**
 * All order ids that still have metadata (i.e. created within the last 48h).
 * Used by the burn-backstop sweep — it can't rely on `paycrest:payout:*` keys
 * because those only exist once a webhook or poll has set a payout status,
 * and a fully-stranded burn's order may never have reached that point.
 */
export async function listOrderMetaIds(): Promise<string[]> {
  const prefix = key("");
  const ids: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, {
      match: `${prefix}*`,
      count: 200,
    });
    cursor = next;
    for (const k of batch) ids.push(k.slice(prefix.length));
  } while (cursor !== "0");
  return ids;
}
