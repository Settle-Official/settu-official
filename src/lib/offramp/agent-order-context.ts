import type { AgentOrderExtraction } from "./agent-resolver";
import type { OnrampAgentExtraction } from "./agent-onramp-resolver";

// What a card looks like once it's live (onramp: confirmed, waiting on the
// user's bank transfer; offramp: confirmed, mid-execution) or once it's
// finished successfully — sent by AgentPanel on every request so the parse
// route's classifier can tell "I sent the money" (a status comment on THIS
// order) apart from a fresh request, and so "do that again" has something
// concrete to repeat.
export interface PendingOfframpOrder {
  direction: "offramp";
  amount: string;
  token: string;
  sourceChain: string;
  beneficiary: { institution: string; accountIdentifier: string; currency: string };
}
export interface PendingOnrampOrder {
  direction: "onramp";
  fiatAmount: string;
  currency: string;
  refundAccount: { institution: string };
}
export type PendingOrder = PendingOfframpOrder | PendingOnrampOrder;

export interface CompletedOfframpOrder {
  direction: "offramp";
  amount: string;
  token: string;
  sourceChain: string;
  beneficiary: { institution: string; accountIdentifier: string; currency: string };
}
export interface CompletedOnrampOrder {
  direction: "onramp";
  fiatAmount: string;
  currency: string;
  destinationAddress: string;
  refundAccount: { institution: string; accountIdentifier: string };
}
export type CompletedOrder = CompletedOfframpOrder | CompletedOnrampOrder;

export function summarizeOrder(o: PendingOrder | CompletedOrder): string {
  if (o.direction === "offramp") {
    return `an offramp of ${o.amount} ${o.token} from ${o.sourceChain} to ${o.beneficiary.institution} account ${o.beneficiary.accountIdentifier} (payout in ${o.beneficiary.currency})`;
  }
  return `an onramp of ${o.fiatAmount} ${o.currency}${
    "refundAccount" in o && o.refundAccount ? ` with refund bank ${o.refundAccount.institution}` : ""
  }`;
}

// The shape the parse route's extraction schema always has, regardless of
// whichever extra fields (like "intent") the caller's own schema adds.
type MergeableExtraction = AgentOrderExtraction & OnrampAgentExtraction & { direction: "onramp" | "offramp" | null };

/**
 * Backfills every field the model left null (because the user didn't
 * restate it in a "repeat" message) from the last completed order of the
 * matching direction — whatever the user DID explicitly state (e.g. a new
 * amount) is left as-is and wins. The merged result is meant to go through
 * the same classify/resolve pipeline any other extraction goes through, so
 * institution/account/amount all get re-validated rather than trusted
 * blindly from the old order.
 */
export function mergeRepeat<T extends MergeableExtraction>(extraction: T, completed: CompletedOrder): T {
  if (completed.direction === "offramp") {
    return {
      ...extraction,
      direction: "offramp",
      amount: extraction.amount ?? completed.amount,
      token: extraction.token ?? completed.token,
      sourceChain: extraction.sourceChain ?? completed.sourceChain,
      destinationCurrency: extraction.destinationCurrency ?? completed.beneficiary.currency,
      institutionName: extraction.institutionName ?? completed.beneficiary.institution,
      accountIdentifier: extraction.accountIdentifier ?? completed.beneficiary.accountIdentifier,
    };
  }
  return {
    ...extraction,
    direction: "onramp",
    fiatAmount: extraction.fiatAmount ?? completed.fiatAmount,
    fiatCurrency: extraction.fiatCurrency ?? completed.currency,
    destinationStellarAddress: extraction.destinationStellarAddress ?? completed.destinationAddress,
    refundInstitutionName: extraction.refundInstitutionName ?? completed.refundAccount.institution,
    refundAccountIdentifier: extraction.refundAccountIdentifier ?? completed.refundAccount.accountIdentifier,
  };
}
