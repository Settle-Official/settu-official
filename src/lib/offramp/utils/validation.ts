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

export function validateAccountNumber(accountNumber: string): boolean {
  // Nigerian account numbers are typically 10 digits
  return /^\d{10}$/.test(accountNumber);
}

export function sanitizeInput(input: string): string {
  return input.trim().replace(/[^\w\s.-]/g, "");
}

// Fiat corridors we route offramps into. Each must be a currency Paycrest
// publishes a market book for.
export const SUPPORTED_CURRENCIES = ["NGN", "KES"] as const;

export function validateCurrency(currency: string): boolean {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(
    String(currency ?? "").toUpperCase(),
  );
}

export function validateToken(token: string): boolean {
  // Supported tokens
  const supportedTokens = ["USDC", "USDT"];
  return supportedTokens.includes(token.toUpperCase());
}
