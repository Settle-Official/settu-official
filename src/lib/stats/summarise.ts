import type { OfframpTransactionRecord } from "@/lib/offramp/transaction-history";

// The counting rule behind the landing page's figures, kept free of Redis and
// of the baseline JSON so it can be tested directly. See landing-stats.ts for
// why the baseline and the live records are joined by order id.

/** The export's settled totals. Tied to BASELINE_ORDER_IDS — change both or neither. */
export const BASELINE = {
  transfers: 296,
  settledNgn: 16_926_377,
} as const;

export interface LandingStats {
  /** Lifetime completed transfers, offramp and onramp. */
  readonly transfers: number;
  /** Lifetime naira paid out to Nigerian banks — offramps only. */
  readonly settledNgn: number;
}

/**
 * Pure counting rule, separated from Redis so it can be tested.
 *
 * A record without an order id can't be proven absent from the baseline, so
 * it is left out rather than risk counting it twice: the published figure
 * may understate, never overstate. The same goes for a completed offramp
 * whose payout amount was never recorded — it counts as a transfer but adds
 * no naira.
 */
/** The fields the rule reads. A full OfframpTransactionRecord satisfies it. */
export interface SummaryRecord {
  readonly status: OfframpTransactionRecord["status"];
  readonly paycrestOrderId?: string;
  /** "0" until the payout is known — register-burn writes it that way. */
  readonly destinationAmount?: string;
}

export function summarise(
  offramps: readonly SummaryRecord[],
  onrampsDelivered: number,
  /** Order ids already counted in BASELINE. */
  baseline: ReadonlySet<string>,
): LandingStats {
  let liveTransfers = 0;
  let liveNgn = 0;
  for (const r of offramps) {
    if (r.status !== "completed" || !r.paycrestOrderId) continue;
    if (baseline.has(r.paycrestOrderId)) continue;
    liveTransfers += 1;
    const ngn = Number(r.destinationAmount);
    if (Number.isFinite(ngn) && ngn > 0) liveNgn += ngn;
  }
  return {
    transfers: BASELINE.transfers + liveTransfers + Math.max(0, onrampsDelivered),
    settledNgn: BASELINE.settledNgn + liveNgn,
  };
}

