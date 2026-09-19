/**
 * The truth table behind the admin recovery screen.
 *
 * An offramp's state lives in six places and they can all disagree. Working
 * out which one is lying is the slow part of a recovery: a real incident
 * needed Redis reads for the order meta, Horizon for the burn, base64
 * decoding of Soroban params, Iris to confirm the recipient, then curl to
 * register — about forty minutes, all of it mechanical. This gathers the
 * same picture in one call and names what's wrong.
 *
 * Read-only. Nothing here writes; recovery is a separate, explicit call.
 */

import { getOrderMeta, listOrderMetaIds, type OrderMeta } from "./order-meta-store";
import { getPayoutStatus } from "./payout-store";
import { listByAddress, type OfframpTransactionRecord } from "./transaction-history";
import { getCctpTransfer, type CctpTransferRecord } from "../cctp/cctp-store";
import { findBurn, orderRecoverable, isPayoutAlreadyResolved } from "./burn-backstop";
import type { PayoutStatus } from "./types";

/**
 * What's actually wrong, in the order we check it. The first one that
 * matches wins, so the ordering is the diagnosis.
 */
export type OrderVerdict =
  /** Burn confirmed on-chain, nothing registered. Funds are stranded. */
  | "stranded-burn"
  /** Registered but the bridge stalled before minting. */
  | "bridge-stalled"
  /** Paid out, but our permanent record never caught up. */
  | "record-stale"
  /** Nothing burned. Either abandoned before signing, or still in flight. */
  | "no-burn"
  /** The on-chain lookup itself failed. We do NOT know if funds are safe. */
  | "unknown"
  /** Everything agrees. */
  | "healthy";

export interface OrderDiagnosis {
  readonly orderId: string;
  readonly verdict: OrderVerdict;
  /** One line a human can act on, without reading the table. */
  readonly summary: string;
  /** True when recoverOrder() would actually do something here. */
  readonly recoverable: boolean;
  readonly meta: OrderMeta | null;
  readonly payoutStatus: PayoutStatus | null;
  readonly record: OfframpTransactionRecord | null;
  readonly transfer: CctpTransferRecord | null;
  readonly onChainBurn: { readonly txHash: string; readonly amountAtomic: string } | null;
  /** Set when the chain lookup failed; `onChainBurn: null` is then meaningless. */
  readonly lookupError: string | null;
  /** Why the daily sweep would skip this order, if it would. */
  readonly sweepWouldSkip: string | null;
}

const usdc = (atomic: string | undefined) =>
  atomic ? `${(Number(atomic) / 1e6).toFixed(2)} USDC` : "an unknown amount";

/**
 * Diagnose one order. The on-chain lookup is the expensive part (Horizon or
 * an RPC, then Iris), so `skipChainLookup` exists for callers listing many
 * orders at once who only need the cheap Redis picture.
 */
export async function diagnoseOrder(
  orderId: string,
  opts: { readonly skipChainLookup?: boolean } = {},
): Promise<OrderDiagnosis> {
  const meta = await getOrderMeta(orderId);
  const payout = await getPayoutStatus(orderId);
  const payoutStatus = payout?.status ?? null;

  // The record is keyed by burn hash, not order id, so it's reached through
  // the sender's address index rather than looked up directly.
  let record: OfframpTransactionRecord | null = null;
  if (meta?.senderAddress) {
    const rows = await listByAddress(meta.senderAddress, { limit: 50 });
    record = rows.find((r) => r.paycrestOrderId === orderId) ?? null;
  }

  // "Couldn't look" must never be reported as "nothing there": for a
  // stranded burn that is the most dangerous possible answer, because it
  // tells an operator the money is fine when it isn't.
  let onChainBurn: { txHash: string; amountAtomic: string } | null = null;
  let lookupError: string | null = null;
  if (!opts.skipChainLookup && meta?.senderAddress && meta.receiveAddress) {
    try {
      const b = await findBurn(meta);
      onChainBurn = b ? { txHash: b.burnTxHash, amountAtomic: b.amountAtomic } : null;
    } catch (err: any) {
      lookupError = err?.message || "chain lookup failed";
    }
  }

  const transfer = onChainBurn ? await getCctpTransfer(onChainBurn.txHash) : null;

  // Why the daily sweep would pass this over — the question that took
  // longest to answer by hand, because every skip is a silent `continue`.
  let sweepWouldSkip: string | null = null;
  // Read before the type guard below: orderRecoverable narrows `meta` to
  // null on the failing branch, which takes createdAt with it.
  const createdAt = meta?.createdAt ?? null;
  if (!orderRecoverable(meta)) {
    const age = createdAt === null ? 0 : Date.now() - createdAt;
    sweepWouldSkip = createdAt === null
      ? "no order meta (expired after 48h)"
      : age < 8 * 60_000
        ? "inside the 8 minute grace period"
        : age > 24 * 60 * 60_000
          ? "older than the 24 hour window"
          : "source chain has nothing to recover";
  } else if (isPayoutAlreadyResolved(payoutStatus ?? undefined)) {
    sweepWouldSkip = `payout already ${payoutStatus}`;
  }

  const paid = payoutStatus === "settled" || payoutStatus === "validated" ||
    payoutStatus === "fulfilled";

  let verdict: OrderVerdict;
  let summary: string;
  if (onChainBurn && !transfer) {
    verdict = "stranded-burn";
    summary = `${usdc(onChainBurn.amountAtomic)} burned on-chain but never registered — nothing will mint it.`;
  } else if (transfer && transfer.status !== "completed") {
    verdict = "bridge-stalled";
    summary = `Registered but the bridge is stuck at "${transfer.status}".`;
  } else if (paid && record && record.status !== "completed") {
    verdict = "record-stale";
    summary = `Paid out, but our record still says "${record.status}" — the user sees a stuck transfer and gets no notification.`;
  } else if (lookupError) {
    verdict = "unknown";
    summary = `Could not check the chain, so it is NOT safe to assume nothing was burned. ${lookupError}`;
  } else if (!onChainBurn && !opts.skipChainLookup) {
    verdict = "no-burn";
    summary = "No burn found on-chain. Either abandoned before signing, or still in flight.";
  } else {
    verdict = "healthy";
    summary = "Every source agrees.";
  }

  return {
    orderId,
    verdict,
    summary,
    recoverable: verdict === "stranded-burn" || verdict === "bridge-stalled",
    meta,
    payoutStatus,
    record,
    transfer,
    onChainBurn,
    lookupError,
    sweepWouldSkip,
  };
}

/**
 * Every order belonging to one wallet, newest first.
 *
 * Order meta is stored per order id with no sender index, so this scans the
 * meta keyspace and filters. Fine at the current volume (tens of live
 * orders, 48h TTL); if that grows, the fix is a sender index written at
 * order-creation time rather than paging this.
 */
export async function diagnoseWallet(address: string): Promise<OrderDiagnosis[]> {
  const ids = await listOrderMetaIds();
  const mine: { id: string; createdAt: number }[] = [];

  for (const id of ids) {
    const meta = await getOrderMeta(id);
    if (meta?.senderAddress?.toLowerCase() === address.toLowerCase()) {
      mine.push({ id, createdAt: meta.createdAt });
    }
  }

  mine.sort((a, b) => b.createdAt - a.createdAt);

  // Sequential, not Promise.all. Each diagnosis makes a Horizon/RPC call and
  // one Iris call per candidate transaction; fanning a whole wallet out at
  // once rate-limits us and the lookups start failing. A failed lookup is
  // reported honestly as "couldn't check" rather than "no burn", so the
  // parallel version was safe but useless — it mostly returned unknowns.
  const out: OrderDiagnosis[] = [];
  for (const o of mine) {
    out.push(await diagnoseOrder(o.id));
  }
  return out;
}
