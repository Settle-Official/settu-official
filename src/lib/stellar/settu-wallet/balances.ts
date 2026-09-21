// Asset balances for a Settu wallet, read straight from Horizon.

import { STELLAR_HORIZON_URL } from "./account";

export interface WalletBalance {
  code: string;
  issuer: string | null;
  amount: string;
}

// XLM shows as 0 on a sponsored wallet, which reads as an error rather than
// the design, so it is dropped unless the user actually holds some.
export async function fetchBalances(
  publicKey: string,
): Promise<WalletBalance[]> {
  const res = await fetch(`${STELLAR_HORIZON_URL}/accounts/${publicKey}`);
  if (!res.ok) return [];

  const balances = ((await res.json())?.balances ?? []) as Array<{
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
  }>;

  return balances
    .map((b) => ({
      code: b.asset_type === "native" ? "XLM" : (b.asset_code ?? "?"),
      issuer: b.asset_issuer ?? null,
      amount: b.balance,
    }))
    .filter((b) => b.code !== "XLM" || Number(b.amount) > 0);
}

/** Trims Stellar's seven decimal places to something readable. */
export function formatAmount(amount: string): string {
  const value = Number(amount);
  return value === 0 ? "0.00" : value.toFixed(value < 1 ? 4 : 2);
}
