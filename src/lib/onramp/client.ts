import type { OnrampProviderAccount } from "@/lib/offramp/types";
import { TransactionStorage } from "@/lib/transaction-storage";

export interface CreateOnrampOrderInput {
  fiatAmount: string;
  currency: string;
  userStellarAddress: string;
  refundAccount: {
    institution: string;
    accountIdentifier: string;
    accountName: string;
  };
  /**
   * What the caller already worked out this order buys, used only when the
   * provider quotes no rate of its own. Without a figure here or a rate
   * back, the stored row has no USDC amount at all.
   */
  readonly estimatedUsdc?: string;
}

export interface CreateOnrampOrderResult {
  id: string;
  status: string;
  providerAccount: OnrampProviderAccount;
  /** USDC the order buys, as the provider computed it. */
  usdcAmount?: string;
  /** Fiat per USDC at creation. */
  rate?: string;
}

/**
 * Creates an onramp order via the server route. Thrown errors carry the
 * server's own message (validation failure, or a friendly upstream-outage
 * message for a Paycrest 5xx) — callers show it directly, same contract
 * OnrampPanel's try/catch already assumed before this was extracted.
 *
 * A successful order is also recorded in the wallet's local history (the
 * same store offramps use) so the overview/history screens can show it;
 * the row's status is advanced by whichever surface watches the order.
 */
export async function createOnrampOrder(
  input: CreateOnrampOrderInput,
  meta: { initiator: "form" | "agent" } = { initiator: "form" },
): Promise<CreateOnrampOrderResult> {
  const res = await fetch("/api/onramp/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload?.error || "Failed to create onramp order");
  }
  const result = payload.data as CreateOnrampOrderResult;

  // Most trustworthy first: the provider's own figure, then one derived
  // from the rate it quoted, then whatever the caller worked out.
  const fiat = Number(input.fiatAmount);
  const rate = Number(result.rate);
  const provided = Number(result.usdcAmount);
  const usdc = Number.isFinite(provided) && provided > 0
    ? provided.toFixed(2)
    : Number.isFinite(fiat) && Number.isFinite(rate) && rate > 0
      ? (fiat / rate).toFixed(2)
      : (input.estimatedUsdc ?? "");
  TransactionStorage.save({
    id: TransactionStorage.generateId(),
    timestamp: Date.now(),
    userAddress: input.userStellarAddress,
    amount: usdc,
    currency: input.currency,
    kind: "onramp",
    initiator: meta.initiator,
    fiatAmount: input.fiatAmount,
    payoutOrderId: result.id,
    beneficiary: { ...input.refundAccount, currency: input.currency },
    status: "pending",
  });

  return result;
}
