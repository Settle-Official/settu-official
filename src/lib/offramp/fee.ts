/**
 * Paycrest's sender-fee percentage, configured as a profile-level default on
 * their Sender Dashboard (app.paycrest.io → Settings) — see
 * https://docs.paycrest.io/implementation-guides/sender-api-integration#collect-a-fee-optional.
 *
 * Paycrest deducts this automatically from whatever gross USDC amount we
 * declare when creating an order; there's no separate collection step on our
 * end and no API to read the configured value back. Confirmed against two
 * real settled orders before this was introduced (both showed the dashboard
 * fee as ~0.99%, matching the stale "Includes 1% platform fee" UI text it
 * replaced):
 *
 *   order.amount + order.senderFee === (gross USDC we actually sent)
 *   order.senderFee / (that sum)    === the configured rate
 *
 * i.e. `amount = grossSent * (1 - rate)`. This constant exists so every place
 * we PREDICT/DISPLAY the resulting fiat payout — the app's quote preview, the
 * Telegram alert's shown amount — uses that exact same math, instead of each
 * one computing (or not computing) its own guess at the fee. Keep this in
 * sync with the dashboard setting whenever it changes there.
 */
export const PAYCREST_SENDER_FEE_RATE = 0.003; // 0.3%

/** Applies the sender fee to a gross fiat value to get what the recipient actually receives. */
export function applyPaycrestSenderFee(grossFiat: number): number {
  return grossFiat * (1 - PAYCREST_SENDER_FEE_RATE);
}

/**
 * Inverts applyPaycrestSenderFee: given the fiat amount the recipient should
 * actually receive (net), returns the gross fiat amount that produces it —
 * i.e. solves `netFiat = grossFiat * (1 - RATE)` for grossFiat. Division, not
 * `netFiat * (1 + RATE)` — those aren't the same thing, and only the division
 * form nets to exactly `netFiat` after applyPaycrestSenderFee is applied to
 * it. Used for "I want the recipient to receive exactly X" flows (the
 * offramp amount-in-fiat mode), the mirror image of the normal "I'm sending
 * X crypto, what does the recipient get" direction.
 */
export function invertPaycrestSenderFee(netFiat: number): number {
  return netFiat / (1 - PAYCREST_SENDER_FEE_RATE);
}
