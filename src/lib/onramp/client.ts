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
}

export interface CreateOnrampOrderResult {
  id: string;
  status: string;
  providerAccount: OnrampProviderAccount;
  /** Fiat amount the order was created for. */
  amount?: string;
  /** Fiat per USDC at creation, when the provider quoted one. */
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

  const fiat = Number(input.fiatAmount);
  const rate = Number(result.rate);
  const usdc = Number.isFinite(fiat) && Number.isFinite(rate) && rate > 0 ? (fiat / rate).toFixed(2) : "";
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
