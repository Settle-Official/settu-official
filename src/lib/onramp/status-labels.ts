/**
 * User-facing copy for each onramp status, shared between OnrampPanel's own
 * status display and Agent Mode's chat narration — one source of truth so
 * the two surfaces never drift apart in wording.
 */
export const ONRAMP_STATUS_LABEL: Record<string, string> = {
  pending: "Waiting for your bank transfer…",
  deposited: "Fiat received — confirming…",
  validated: "Payment confirmed by provider…",
  settling: "Releasing USDC on Base…",
  settled: "USDC received — bridging to Stellar…",
  bridging: "Bridging to your Stellar wallet…",
  delivered: "Delivered to your Stellar wallet ✓",
  bridge_failed: "Delivery held for review — our team was alerted.",
  refunding: "Refund in progress…",
  refunded: "Order refunded.",
  expired: "Order expired — no deposit received in time.",
  unknown: "Processing…",
};
