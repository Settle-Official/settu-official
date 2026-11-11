// Input validation utilities

export function validateAmount(amount: string): boolean {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0 && isFinite(num);
}

export function validateAddress(address: string, chain: "stellar" | "base"): boolean {
  if (!address) return false;

  if (chain === "stellar") {
    // Stellar addresses start with G and are 56 characters
    return /^G[A-Z0-9]{55}$/.test(address);
  }

  if (chain === "base") {
    // Ethereum-compatible addresses
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  return false;
}

/**
 * Permissive shape check across every corridor. NGN bank accounts are 10
 * digits, but UGX is mobile-money only and KES/TZS mix banks with mobile
 * money, where the identifier is a phone number of varying length — a strict
 * 10-digit rule makes those corridors unreachable.
 *
 * Paycrest's verify-account is the real authority and returns precise
 * field-level errors; this only catches obvious junk before we call it.
 */
export function validateAccountNumber(accountNumber: string): boolean {
  return /^\+?\d{6,20}$/.test(String(accountNumber ?? "").trim());
}

/** Paycrest institution codes carry the country in characters 5-6 (OPAYNGPC, KCBLKENX). */
function isNigerianInstitution(institution: string): boolean {
  return String(institution ?? "").trim().toUpperCase().slice(4, 6) === "NG";
}

/**
 * Puts an account number into the form the payout rails expect.
 *
 * Nigerian accounts are 10-digit NUBANs. Wallet banks (OPay, PalmPay,
 * Moniepoint...) use the holder's phone number without its leading 0, so
 * people often type the full 11-digit phone number instead. Paycrest's
 * verify-account accepts that and returns the right name, but the provider's
 * payout then fails and the order is refunded after the user's USDC has
 * moved (orders 66d1904a and 5339ee2d, 2026-11-10/11). Dropping the leading 0
 * gives the NUBAN; everything else is only trimmed of spaces and dashes.
 */
export function normalizeAccountIdentifier(
  institution: string,
  accountIdentifier: string,
): string {
  const id = String(accountIdentifier ?? "").trim().replace(/[\s-]/g, "");
  if (isNigerianInstitution(institution) && /^0\d{10}$/.test(id)) {
    return id.slice(1);
  }
  return id;
}

/** After normalising: a Nigerian account must be exactly 10 digits. */
export function isPayableAccountIdentifier(
  institution: string,
  accountIdentifier: string,
): boolean {
  if (!validateAccountNumber(accountIdentifier)) return false;
  return !isNigerianInstitution(institution) || /^\d{10}$/.test(accountIdentifier);
}

export function sanitizeInput(input: string): string {
  return input.trim().replace(/[^\w\s.-]/g, "");
}

/**
 * Shape check only — ISO 4217, three uppercase letters, per Paycrest's code
 * standards. Which currencies are actually supported is asked of Paycrest at
 * runtime (see isSupportedCurrency in the adapter) rather than hardcoded here,
 * so a corridor they add needs no code change.
 */
export function validateCurrency(currency: string): boolean {
  return /^[A-Z]{3}$/.test(String(currency ?? "").toUpperCase());
}

export function validateToken(token: string): boolean {
  // Supported tokens
  const supportedTokens = ["USDC", "USDT"];
  return supportedTokens.includes(token.toUpperCase());
}
