/**
 * Which of this browser's transfers to check for a burn when the offramp
 * screen opens.
 *
 * If iOS closed the page while the user was in their wallet app, the flow
 * that would have registered the burn is gone with it. Its local record
 * survives, though: written before the wallet prompt, with the Paycrest
 * order id, and only given a burn hash once the wallet replied. A record
 * like that may be sitting on a burn nobody registered.
 */

import type { Transaction } from "../transaction-storage";

// Older than this is the sweep's and the admin console's job, not a page
// load's (and matches the backstop's own window).
const MAX_AGE_MS = 24 * 60 * 60_000;
// Each check can cost a chain lookup: never a burst on page load.
const MAX_CHECKS = 3;

export function transfersAwaitingBurn(
  transactions: readonly Transaction[],
  now: number,
): Transaction[] {
  return transactions
    .filter(
      (t) =>
        (t.kind ?? "offramp") === "offramp" &&
        // "failed" too: a wallet reply that timed out after the burn landed
        // leaves exactly this record behind.
        (t.status === "pending" || t.status === "failed") &&
        !!t.payoutOrderId &&
        !t.stellarTxHash &&
        now - t.timestamp < MAX_AGE_MS,
    )
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_CHECKS);
}
