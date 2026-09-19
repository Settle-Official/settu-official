import { NextRequest, NextResponse } from "next/server";
import { getOrderMeta } from "@/lib/offramp/order-meta-store";
import { getPayoutStatus } from "@/lib/offramp/payout-store";
import { reconcilePayoutOrder } from "@/lib/offramp/settlement";
import {
  indexExistingOrder,
  listAllPaged,
  updateTransactionByOrderId,
} from "@/lib/offramp/transaction-history";

export const runtime = "nodejs";
export const maxDuration = 60;

// Paycrest states that mean the recipient was actually paid, vs. the ones
// that mean the money came back. Everything else is still in flight and is
// left alone.
const PAID = new Set(["validated", "fulfilled", "settled"]);
const LOST = new Set(["refunded", "expired"]);

/**
 * Repairs transaction records whose status never tracked their payout.
 *
 * Nothing updated these records after creation, so a bridged offramp stayed
 * "pending" forever while a Base-direct one claimed "completed" from the
 * moment it was registered. Both are now written correctly at settlement;
 * this reconciles the records that were created before that, against the
 * payout store, which has the real outcome. It also backfills the by-order
 * index so later settlements resolve in one read.
 *
 * Safe to run repeatedly — it only writes when the payout store disagrees
 * with the record, and it never moves a record back to pending.
 *
 * Auth: `Authorization: Bearer $ADMIN_API_SECRET` (required in production).
 * Paged via `?offset=&limit=` so a large store can be walked in chunks;
 * `?dryRun=1` reports what would change without writing.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.ADMIN_API_SECRET;
  if (secret) {
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const dryRun = url.searchParams.get("dryRun") === "1";
  // Off by default: this is the only part that costs an external API call
  // per record, so it is asked for explicitly rather than assumed.
  const useLive = url.searchParams.get("live") === "1";

  const records = await listAllPaged(offset, limit);
  const changes: {
    id: string;
    orderId: string;
    was: string;
    now: string;
    payoutStatus: string;
  }[] = [];
  let skippedNoOrder = 0;
  let skippedInFlight = 0;
  let alreadyCorrect = 0;
  // Records left with destinationAmount "0" because their order meta had
  // already expired — History can never show an amount for these.
  let amountUnrecoverable = 0;

  for (const record of records) {
    const orderId = record.paycrestOrderId;
    if (!orderId) {
      skippedNoOrder++;
      continue;
    }

    if (!dryRun) await indexExistingOrder(record);

    const payout = await getPayoutStatus(orderId);
    // The payout store is operational and TTL'd, so an older order usually
    // has no cached status left — which is exactly the case this backfill
    // exists for. `live=1` asks Paycrest itself instead, at one API call per
    // record, and reconcilePayoutOrder writes the answer back into the
    // payout store on the way through.
    const payoutStatus =
      payout?.status ?? (useLive && !dryRun ? await reconcilePayoutOrder(orderId) : undefined);
    if (!payoutStatus || payoutStatus === "unknown") {
      skippedInFlight++;
      continue;
    }

    const target = PAID.has(payoutStatus)
      ? "completed"
      : LOST.has(payoutStatus)
        ? "failed"
        : null;
    if (!target) {
      skippedInFlight++;
      continue;
    }
    if (record.status === target) {
      alreadyCorrect++;
      continue;
    }
    if (!record.destinationAmount || Number(record.destinationAmount) === 0) {
      const meta = await getOrderMeta(orderId);
      if (!meta?.payoutValue) amountUnrecoverable++;
    }

    changes.push({
      id: record.id,
      orderId,
      was: record.status,
      now: target,
      payoutStatus,
    });

    if (!dryRun) {
      // Fill in the payout figure too, not just the status. register-burn
      // writes destinationAmount "0" because the payout isn't known at burn
      // time, and nothing else backfills it — which leaves History with a
      // completed transfer showing no amount received and no rate. Order
      // meta holds the real figure but expires after 48h, so this is only
      // recoverable while it's still there; past that the record keeps "0".
      const meta = await getOrderMeta(orderId);
      const needsAmount =
        !record.destinationAmount || Number(record.destinationAmount) === 0;
      await updateTransactionByOrderId(orderId, target, {
        ...(payout?.txHash ? { mintTxHash: payout.txHash } : {}),
        ...(needsAmount && meta?.payoutValue
          ? { destinationAmount: String(meta.payoutValue) }
          : {}),
      });
    }
  }

  return NextResponse.json({
    dryRun,
    live: useLive,
    offset,
    limit,
    scanned: records.length,
    // Page again from here while this equals `limit`.
    nextOffset: records.length === limit ? offset + limit : null,
    corrected: changes.length,
    alreadyCorrect,
    skippedNoOrder,
    skippedInFlight,
    amountUnrecoverable,
    changes,
  });
}
