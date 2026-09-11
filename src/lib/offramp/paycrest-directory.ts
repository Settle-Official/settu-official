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

/**
 * Returns the verified account holder name, or null if Paycrest couldn't
 * verify it (bad account number, unreachable, or the "OK" sentinel some
 * corridors — e.g. KES M-Pesa — return instead of a real name).
 */
export async function verifyAccount(
  institution: string,
  accountIdentifier: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${PAYCREST_API_BASE}/verify-account`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ institution, accountIdentifier }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.data?.accountName || data?.data || data?.accountName || "";
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || name.toUpperCase() === "OK") return null;
    return name;
  } catch {
    return null;
  }
}
