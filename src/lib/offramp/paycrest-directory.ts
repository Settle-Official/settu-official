// Server-usable equivalents of the Paycrest public-API calls FormCard.tsx
// already makes from the browser (currencies, institutions, verify-account —
// none of these three need PAYCREST_API_KEY; they're public reference data).

const PAYCREST_API_BASE = "https://api.paycrest.io/v1";

export interface PaycrestCurrency {
  code: string;
  name: string;
  symbol: string;
}

export interface PaycrestInstitution {
  code: string;
  name: string;
  type?: string;
}

export async function fetchCurrencies(): Promise<PaycrestCurrency[]> {
  try {
    const res = await fetch(`${PAYCREST_API_BASE}/currencies`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

export async function fetchInstitutions(currency: string): Promise<PaycrestInstitution[]> {
  try {
    const res = await fetch(
      `${PAYCREST_API_BASE}/institutions/${encodeURIComponent(currency)}`,
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}

export interface VerifyAccountResult {
  /** True the instant Paycrest confirms the account exists, regardless of
   * whether they also gave us a display name. */
  verified: boolean;
  /** The real account holder name, or null if verified with no name (the
   * "OK" sentinel some corridors — e.g. KES M-Pesa — return instead of a
   * name) or not verified at all. */
  accountName: string | null;
}

/**
 * Confirmed live: NGN's verify-account always returns a real name
 * ({"data": "UCHE MACNELSON OFATU"}), but KES returns the literal string
 * "OK" instead ({"data": "OK"}) — Paycrest verified the account exists but
 * has no name to give back for that corridor. Callers decide per-currency
 * whether a missing name should still block (see agent-resolver.ts /
 * agent-onramp-resolver.ts / FormCard.tsx, which all require a real name
 * for NGN specifically but accept `verified` alone for every other
 * currency) — this function only reports what Paycrest actually said.
 */
export async function verifyAccount(
  institution: string,
  accountIdentifier: string,
): Promise<VerifyAccountResult> {
  const notVerified: VerifyAccountResult = { verified: false, accountName: null };
  try {
    const res = await fetch(`${PAYCREST_API_BASE}/verify-account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ institution, accountIdentifier }),
    });
    if (!res.ok) return notVerified;
    const data = await res.json();
    const raw = data?.data?.accountName || data?.data || data?.accountName || "";
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name) return notVerified;
    if (name.toUpperCase() === "OK") return { verified: true, accountName: null };
    return { verified: true, accountName: name };
  } catch {
    return notVerified;
  }
}
