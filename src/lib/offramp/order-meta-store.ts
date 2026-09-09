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
   * Paycrest's per-order deposit address — the CCTP burn's mintRecipient.
   * Stashed so a stuck/expired order can be diagnosed straight from our own
   * store instead of re-fetching it from Paycrest's API, and so a burn found
   * on-chain with no matching CctpTransferRecord can be matched back to an
   * order by address.
   */
  receiveAddress?: string;
  /**
   * The provider queue this order was routed to, best-rate first, and where the
   * rate came from. Kept for support triage: a settlement that went wrong is
   * much easier to chase when you know which providers were in play and whether
   * the rate was book-derived or taken from the client's quote.
   */
  providerIds?: string[];
  rateSource?: "book" | "client";
  /** Who initiated this offramp. Absent on orders predating attribution. */
  userStellarAddress?: string;
  /** "client" is self-declared and unverified; "session" is proven ownership. */
  attributionSource?: "client" | "session";
  /** USDC sent from Stellar, before the bridge fee. amountUsdc is post-bridge. */
  grossAmountUsdc?: number;
  /** Marks platform-funded cashback payouts so they stay out of public stats. */
  kind?: "cashback_withdrawal";
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
