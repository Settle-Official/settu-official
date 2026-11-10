/**
 * Paycrest order-creation failures, translated for two audiences: the order
 * route (which can recover from some of them) and the user (who should never
 * see a raw API payload).
 */

/**
 * Paycrest rejects an order whose rate is more than its tolerance (0.2% at the
 * time of writing) away from its own market rate, and names that market rate
 * in the error:
 *
 *   {"status":"error","message":"Failed to validate payload","data":
 *    {"field":"Rate","message":"Provided rate 1374.12 is outside 0.20%
 *    tolerance of market rate 1370.12"}}
 *
 * The provider book we price from can sit further than that from Paycrest's
 * market rate, so this happens in normal use. Returns the market rate when
 * the error is that rejection, null for anything else.
 */
export function marketRateFromToleranceError(error: unknown): number | null {
  const text = errorText(error);
  if (!/tolerance/i.test(text)) return null;
  const match = text.match(/market rate\s+([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const rate = Number(match[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function errorText(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const parts: string[] = [];
  const e = error as { message?: unknown; details?: unknown };
  if (typeof e.message === "string") parts.push(e.message);
  if (e.details !== undefined) {
    try {
      parts.push(typeof e.details === "string" ? e.details : JSON.stringify(e.details));
    } catch {
      // unserialisable details — the message alone will have to do
    }
  }
  return parts.join(" ");
}

/**
 * The line the user sees when the order route fails. The order is created
 * before anything is burned or sent, so at this point no funds have moved —
 * every message can say so. The raw payload is for logs, never the screen.
 */
export function friendlyOrderError(payload: unknown, status: number): string {
  const p = (payload ?? {}) as { code?: unknown; message?: unknown; error?: unknown; details?: unknown };
  const noFunds = "No funds have left your wallet.";

  if (p.code === "RATE_MOVED" || marketRateFromToleranceError(p) !== null) {
    return `The exchange rate changed while we were setting up your order. Please try again to get a fresh rate. ${noFunds}`;
  }
  if (status === 504 || status === 502) {
    return `Our payout partner is taking too long to respond. Please try again in a moment. ${noFunds}`;
  }

  const text = errorText(p);
  if (/accountIdentifier|accountName|institution|recipient|account number|bank/i.test(text)) {
    return `We couldn't set up a payout to that bank account. Please check the bank details and try again. ${noFunds}`;
  }
  if (/amount|minimum|maximum|limit/i.test(text)) {
    return `That amount can't be paid out right now. Please try a different amount. ${noFunds}`;
  }
  return `We couldn't set up your payout just now. Please try again in a moment. ${noFunds}`;
}
