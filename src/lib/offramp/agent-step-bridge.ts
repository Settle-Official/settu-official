import type { OfframpStep } from "../../components/TransactionProgressModal";

export interface AgentStepEvent {
  /** Stable per step value — lets the caller de-dupe if the same step fires twice. */
  id: string;
  kind: "progress" | "success" | "error";
  text: string;
}

/**
 * Maps an `offrampStep` transition to a chat message, so AgentPanel can
 * narrate execution the way TransactionProgressModal renders it as a
 * stepper. Pure and synchronous — no access to `tradeState` beyond what's
 * passed in, so it's fully unit-testable without running an offramp.
 */
export function stepToAgentEvent(
  step: OfframpStep,
  opts: { sourceChainLabel: string; error?: string | null },
): AgentStepEvent | null {
  switch (step) {
    case "idle":
      return null;
    case "initiating":
      return { id: "initiating", kind: "progress", text: "Starting your offramp…" };
    case "awaiting-signature":
      return {
        id: "awaiting-signature",
        kind: "progress",
        text: "Confirm the transaction in your wallet…",
      };
    case "submitting":
      return {
        id: "submitting",
        kind: "progress",
        text: `Submitting on ${opts.sourceChainLabel}…`,
      };
    case "processing":
      return { id: "processing", kind: "progress", text: "Transaction processing…" };
    case "settling":
      return {
        id: "settling",
        kind: "progress",
        text: "Confirming settlement in fiat…",
      };
    case "success":
      return { id: "success", kind: "success", text: "✅ Offramp complete." };
    case "error":
      return {
        id: "error",
        kind: "error",
        text: `❌ ${opts.error || "Something went wrong — please try again."}`,
      };
    default: {
      const exhaustive: never = step;
      return exhaustive;
    }
  }
}
