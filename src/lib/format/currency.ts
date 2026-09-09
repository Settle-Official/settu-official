// One fiat formatter for the app; replaces four divergent copies.

// Live corridors, per FIAT_MIN_STEP in src/lib/offramp/fiat-conversion.ts.
const FIAT_SYMBOLS: Record<string, string> = {
  NGN: "₦",
  KES: "KSh",
  UGX: "USh",
  TZS: "TSh",
};

export function fiatSymbol(currency?: string, symbolOverride?: string): string {
  if (symbolOverride) return symbolOverride;
  const code = (currency || "NGN").toUpperCase();
  return FIAT_SYMBOLS[code] ?? code;
}

// Single-char symbols sit flush (₦1.00); word-like ones need a space (KSh 1.00).
function joinSymbol(symbol: string, formatted: string): string {
  return symbol.length === 1 ? `${symbol}${formatted}` : `${symbol} ${formatted}`;
}

// Accepts Redis string amounts and UI numbers; "--" for anything unparseable.
export function formatFiat(
  amount: number | string | null | undefined,
  currency?: string,
  symbolOverride?: string,
): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (num === null || num === undefined || !Number.isFinite(num)) return "--";

  const formatted = num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return joinSymbol(fiatSymbol(currency, symbolOverride), formatted);
}
