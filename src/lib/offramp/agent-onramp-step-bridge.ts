import { ONRAMP_STATUS_LABEL } from "../onramp/status-labels";

export interface OnrampStepEvent {
  id: string;
  kind: "progress" | "success" | "error";
  text: string;
}

const ERROR_STATUSES = new Set(["bridge_failed", "refunding", "refunded", "expired"]);

/**
 * Maps an onramp order's status (from the /api/onramp/stream SSE payload) to
 * a chat message, reusing OnrampPanel's own ONRAMP_STATUS_LABEL copy so the
 * two surfaces never say different things for the same status. Pure and
 * synchronous — no network access — so it's fully unit-testable.
 */
export function onrampStatusToAgentEvent(
  status: string,
  opts: { stellarTxHash?: string },
): OnrampStepEvent | null {
  const label = ONRAMP_STATUS_LABEL[status];
  if (!label) return null;

  if (status === "delivered") {
    const shortHash = opts.stellarTxHash ? opts.stellarTxHash.slice(0, 8) : null;
    return {
      id: status,
      kind: "success",
      text: shortHash ? `✅ ${label} (tx ${shortHash}…)` : `✅ ${label}`,
    };
  }

  return {
    id: status,
    kind: ERROR_STATUSES.has(status) ? "error" : "progress",
    text: label,
  };
}
