import { listAllPaged, type OfframpTransactionRecord } from "@/lib/offramp/transaction-history";
import { countOnrampDelivered } from "@/lib/onramp/onramp-store";
import BASELINE_ORDER_IDS from "./baseline-orders.json";
import { summarise, type LandingStats } from "./summarise";

export { BASELINE, type LandingStats } from "./summarise";

/** The export's 296 settled order ids — tied to BASELINE in summarise.ts. */
const BASELINE_ORDERS: ReadonlySet<string> = new Set(BASELINE_ORDER_IDS);

/**
 * The landing page's headline figures: every transfer Settu has completed,
 * and the naira it has paid out to Nigerian banks.
 *
 * Two sources, joined without overlap:
 *
 * 1. A baseline reconciled from the Paycrest sender-orders export
 *    (2026-02-17 to 2026-09-19): 296 settled offramps worth ₦16,926,377.
 *    It predates the transaction history, so it's the only record of them.
 * 2. Everything the durable stores have recorded since — completed offramps
 *    from the transaction history, delivered onramps from their index.
 *
 * The join is by ORDER ID, not by date. A completed offramp is either one of
 * the export's 296 (already in the baseline) or it isn't (count it here).
 * A date cutoff can't do this: the history records rebuilt on 2026-09-19
 * carry the rebuild time, not the order's, so they fall after any cutoff
 * while their orders are already in the export — 7 would have counted twice.
 *
 * This replaced a pair of counters incremented at settlement. Those only
 * counted settlements processed by code that had them, so everything
 * between the export and the deploy that shipped them was lost for good —
 * and they were incremented by local dev servers too, which share the
 * production Redis. Reading the durable records is self-healing: it counts
 * what actually settled, whichever server handled it.
 */

const PAGE = 200;

export async function getLandingStats(): Promise<LandingStats> {
  const offramps: OfframpTransactionRecord[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await listAllPaged(offset, PAGE);
    offramps.push(...page);
    if (page.length < PAGE) break;
  }
  return summarise(offramps, await countOnrampDelivered(), BASELINE_ORDERS);
}
