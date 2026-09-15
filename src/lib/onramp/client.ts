import type { OnrampProviderAccount } from "@/lib/offramp/types";

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
}

/**
 * Creates an onramp order via the server route. Thrown errors carry the
 * server's own message (validation failure, or a friendly upstream-outage
 * message for a Paycrest 5xx) — callers show it directly, same contract
 * OnrampPanel's try/catch already assumed before this was extracted.
 */
export async function createOnrampOrder(
  input: CreateOnrampOrderInput,
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
  return payload.data as CreateOnrampOrderResult;
}
