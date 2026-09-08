// Provider routing — rank the Paycrest market book to pick an order's provider queue.
//
// Pure and side-effect free (no network, no env) so the ranking rules stay unit
// testable; fetching the book lives in PaycrestAdapter.getMarketBook.
//
// Selection priority is: can-settle → rate → success rate. Eligibility is decided
// before anything is ranked — the best rate in a corridor is worthless if that
// provider cannot actually fill the amount.

import type { MarketOffer, MarketSide, ProviderSelection } from "./types";

/** Paycrest caps `destination.providerIds` at 3 for a fiat destination. */
export const PROVIDER_QUEUE_LIMIT = 3;
export const DEFAULT_MIN_SUCCESS_PERCENT = 90;

export interface SelectTopProvidersOptions {
  /** Token units (e.g. USDC) actually being traded — post-bridge, not the user's input. */
  amount: number;
  side: MarketSide;
  fiat: string;
  token: string;
  network: string;
  limit?: number;
  minSuccessPercent?: number;
}

/** Parse a Paycrest numeric string, rejecting anything non-finite. */
function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Success rate as a number; null when the provider has no history. */
function successOf(offer: MarketOffer): number | null {
  return offer.successPercent == null ? null : num(offer.successPercent);
}

function sameText(a: unknown, b: string): boolean {
  return String(a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Phase A — can this offer actually settle `amount`?
 *
 * Returns the parsed rate when the offer qualifies, or null when any capability
 * gate fails. Every check here is a hard filter.
 */
function qualifyingRate(
  offer: MarketOffer,
  opts: SelectTopProvidersOptions,
): number | null {
  // Corridor. Not redundant with the query params: `fiat=NGN,KES` returns both
  // corridors interleaved in a single book.
  if (
    !offer?.providerId ||
    !sameText(offer.side, opts.side) ||
    !sameText(offer.fiat, opts.fiat) ||
    !sameText(offer.token, opts.token) ||
    !sameText(offer.network, opts.network)
  ) {
    return null;
  }

  // Amount sits inside the tier band. Drop malformed rows rather than letting a
  // NaN comparison silently pass.
  const rate = num(offer.rate);
  const min = num(offer.min);
  const max = num(offer.max);
  if (rate === null || rate <= 0 || min === null || max === null) return null;
  if (opts.amount < min || opts.amount > max) return null;

  // Provider holds enough liquidity to pay it out. `balance` is fiat for a sell
  // and token for a buy — the difference between willing to quote and able to
  // settle.
  const balance = num(offer.balance);
  if (balance === null) return null;
  const required = opts.side === "sell" ? opts.amount * rate : opts.amount;
  if (balance < required) return null;

  return rate;
}

/**
 * Rank eligible providers and return the ordered fallback queue.
 *
 * An empty result is a valid outcome (thin corridor, amount outside every band,
 * markets hiccup) — callers fall back rather than treating it as an error.
 */
export function selectTopProviders(
  book: MarketOffer[],
  opts: SelectTopProvidersOptions,
): ProviderSelection {
  const empty: ProviderSelection = {
    providerIds: [],
    rate: 0,
    offers: [],
    relaxedSuccessFloor: false,
  };

  if (!Array.isArray(book) || !Number.isFinite(opts.amount) || opts.amount <= 0) {
    return empty;
  }

  const limit = Math.max(0, opts.limit ?? PROVIDER_QUEUE_LIMIT);
  const floor = opts.minSuccessPercent ?? DEFAULT_MIN_SUCCESS_PERCENT;

  // Phase A — who can settle this amount.
  const eligible: Array<{ offer: MarketOffer; rate: number }> = [];
  for (const offer of book) {
    const rate = qualifyingRate(offer, opts);
    if (rate !== null) eligible.push({ offer, rate });
  }
  if (eligible.length === 0) return empty;

  // Phase B — of those, the ones with a good success rate. A soft gate: in a thin
  // corridor, routing to a mediocre provider that can settle beats failing outright.
  const aboveFloor = eligible.filter((e) => {
    const success = successOf(e.offer);
    return success !== null && success >= floor;
  });
  const relaxedSuccessFloor = aboveFloor.length === 0;
  const survivors = relaxedSuccessFloor ? eligible : aboveFloor;

  // Phase C — top N distinct providers by rate.
  //
  // Collapse to one tier per provider BEFORE sorting; ranking rows directly is
  // what would fill the queue with the same provider three times.
  const best = new Map<string, { offer: MarketOffer; rate: number }>();
  for (const entry of survivors) {
    const current = best.get(entry.offer.providerId);
    if (!current) {
      best.set(entry.offer.providerId, entry);
      continue;
    }
    const better =
      opts.side === "sell" ? entry.rate > current.rate : entry.rate < current.rate;
    if (better) {
      best.set(entry.offer.providerId, entry);
      continue;
    }
    // Equal rates across a provider's own tiers: prefer the lower band so the
    // pick is deterministic regardless of the order the API returned them in.
    if (entry.rate === current.rate) {
      const a = num(entry.offer.min);
      const b = num(current.offer.min);
      if (a !== null && b !== null && a < b) best.set(entry.offer.providerId, entry);
    }
  }

  const ranked = [...best.values()].sort((a, b) => {
    // Rate leads.
    if (a.rate !== b.rate) {
      return opts.side === "sell" ? b.rate - a.rate : a.rate - b.rate;
    }
    // Success rate breaks the ties rate leaves behind — which is frequent.
    // Providers with no history sort last.
    const sa = successOf(a.offer);
    const sb = successOf(b.offer);
    if (sa !== sb) {
      if (sa === null) return 1;
      if (sb === null) return -1;
      if (sa !== sb) return sb - sa;
    }
    const settledA = num(a.offer.settled) ?? 0;
    const settledB = num(b.offer.settled) ?? 0;
    if (settledA !== settledB) return settledB - settledA;
    // Final key: keeps ties stable instead of API-order-dependent.
    return a.offer.providerId.localeCompare(b.offer.providerId);
  });

  const top = ranked.slice(0, limit);
  if (top.length === 0) return empty;

  return {
    providerIds: top.map((e) => e.offer.providerId),
    rate: top[0].rate,
    offers: top.map((e) => e.offer),
    relaxedSuccessFloor,
  };
}
