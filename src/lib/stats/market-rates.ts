/**
 * Live USDC → local currency rates for the landing page's markets ticker.
 * Read from Paycrest's public market book (the same book offramp orders are
 * priced from) and cached with the page's 5-minute ISR, so a visit never
 * calls Paycrest directly.
 */

export const MARKETS = [
  { code: "NGN", country: "Nigeria", flag: "ng", symbol: "₦" },
  { code: "GHS", country: "Ghana", flag: "gh", symbol: "GH₵" },
  { code: "KES", country: "Kenya", flag: "ke", symbol: "KSh" },
  { code: "TZS", country: "Tanzania", flag: "tz", symbol: "TSh" },
  { code: "RWF", country: "Rwanda", flag: "rw", symbol: "FRw" },
  { code: "UGX", country: "Uganda", flag: "ug", symbol: "USh" },
  { code: "ZMW", country: "Zambia", flag: "zm", symbol: "ZK" },
] as const;

export type Market = (typeof MARKETS)[number];
/** rate: best live rate per 1 USDC, or null when no provider is quoting. */
export type MarketRate = Market & { readonly rate: number | null };

/** The highest sell rate in a Paycrest v2 market-book response — the best a seller can get. */
export function bestSellRate(payload: unknown): number | null {
  const book = (payload as { data?: { book?: unknown } } | null)?.data?.book;
  if (!Array.isArray(book)) return null;
  let best: number | null = null;
  for (const entry of book) {
    const r = Number((entry as { rate?: unknown })?.rate);
    if (Number.isFinite(r) && r > 0 && (best === null || r > best)) best = r;
  }
  return best;
}

/** ₦1,428 · GH₵12.11 — two decimals only where whole units would hide the rate. */
export function formatRate(m: Pick<Market, "symbol">, rate: number): string {
  const digits = rate < 100 ? 2 : 0;
  return `${m.symbol}${rate.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export async function getMarketRates(): Promise<MarketRate[]> {
  return Promise.all(
    MARKETS.map(async (m) => {
      try {
        const res = await fetch(
          `https://api.paycrest.io/v2/markets?side=sell&fiat=${m.code}&token=USDC&network=base`,
          { next: { revalidate: 300 }, signal: AbortSignal.timeout(5000) },
        );
        return { ...m, rate: res.ok ? bestSellRate(await res.json()) : null };
      } catch {
        // A slow or failed book must never break the landing page.
        return { ...m, rate: null };
      }
    }),
  );
}
