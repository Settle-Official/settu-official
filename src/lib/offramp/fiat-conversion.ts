// Fiat <-> USDC conversion for the offramp quote.
//
// Pure and side-effect free (no network, no env) so the arithmetic stays unit
// testable; fetching the rate and the bridge fee lives in the quote route.
//
// Forward:  fiat = usdc x (1 - bps/10000) x rate x (1 - PLATFORM_FEE_RATE)
// Reverse:  see solveUsdcForFiat -- NOT a plain division, because `rate` is a
//           function of the amount (the market book is tiered by min/max band).

/** Smallest USDC offramp we accept, independent of corridor. */
export const MIN_USDC_AMOUNT = 0.7;

/**
 * Paycrest deducts this from the account config (their order responses carry
 * `senderFeePercent: "0.3"` without us asking). We only mirror it so the figure
 * shown to the user matches what the recipient actually receives — never send a
 * senderFee on a request, or it would be charged twice.
 */
export const PLATFORM_FEE_RATE = 0.003;

/**
 * Rounding step for each corridor's minimum, chosen so the fiat minimum reads
 * as a round number while staying close to MIN_USDC_AMOUNT. At current rates:
 * NGN 1,000 / KES 100 / UGX 3,000 / TZS 2,000 — all 0.74-0.80 USDC.
 */
export const FIAT_MIN_STEP: Record<string, number> = {
  NGN: 1000,
  KES: 100,
  UGX: 1000,
  TZS: 1000,
};

/** Used for any currency Paycrest adds that isn't in FIAT_MIN_STEP yet. */
export const DEFAULT_FIAT_MIN_STEP = 100;

/** USDC decimals on Base — the precision an order amount can carry. */
const USDC_DECIMALS = 6;

/**
 * Paycrest rounds senderFee to 4 decimals before deducting it. Confirmed on
 * two live orders: 0.920861 USDC was charged 0.0028 (exact 0.3% is 0.00276258,
 * rounded up) and 0.773524 was charged 0.0023 (exact 0.00232057, rounded down).
 *
 * We model the fee as rounded *up* rather than to-nearest, so the delivered
 * amount is never below what the user asked for. When Paycrest rounds down
 * instead, they receive up to ~0.0001 USDC more than quoted — deliberately
 * erring over rather than under.
 */
const SENDER_FEE_DECIMALS = 4;

/** Worst-case fee Paycrest will deduct from an amount it receives. */
export function senderFeeFor(usdc: number): number {
  if (!isPositiveFinite(usdc)) return 0;
  return roundUpTo(usdc * PLATFORM_FEE_RATE, SENDER_FEE_DECIMALS);
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/** Fraction of the burn amount that survives the CCTP bridge. */
function bridgeSurvivalFactor(bridgeBps: number): number {
  if (!Number.isFinite(bridgeBps) || bridgeBps <= 0) return 1;
  return 1 - bridgeBps / 10_000;
}

/** Round up to `decimals`, so the user never ends up a hair short. */
export function roundUpTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.ceil(value * factor - 1e-9) / factor;
}

/**
 * Fiat the recipient receives for a given USDC burn.
 *
 * Mirrors Paycrest's own arithmetic — fee deducted from what *arrives* (so
 * post-bridge), quantised to 4dp, then converted — rather than the simpler
 * `usdc * rate * 0.997`, which is off by up to a rounding step of the fee.
 */
export function usdcToFiat(
  usdc: number,
  rate: number,
  bridgeBps: number,
): number {
  if (!isPositiveFinite(usdc) || !isPositiveFinite(rate)) return 0;
  const afterBridge = usdc * bridgeSurvivalFactor(bridgeBps);
  const net = afterBridge - senderFeeFor(afterBridge);
  return net > 0 ? net * rate : 0;
}

/**
 * USDC needed to deliver a given fiat amount, at a KNOWN rate. Rounds up to
 * USDC precision so the resulting fiat is never below what was asked for.
 *
 * This is a single closed-form step — callers that need the rate re-priced
 * against the book must use solveUsdcForFiat.
 */
export function fiatToUsdc(
  fiat: number,
  rate: number,
  bridgeBps: number,
): number {
  if (!isPositiveFinite(fiat) || !isPositiveFinite(rate)) return 0;
  const survival = bridgeSurvivalFactor(bridgeBps);
  const divisor = survival * rate * (1 - PLATFORM_FEE_RATE);
  if (!isPositiveFinite(divisor)) return 0;

  // First pass against the unrounded fee, then correct for the 4dp quantisation
  // until the modelled payout actually clears the target. Converges in one or
  // two passes — each correction moves the amount by less than a fee step.
  let usdc = roundUpTo(fiat / divisor, USDC_DECIMALS);
  for (let i = 0; i < 8; i++) {
    if (usdcToFiat(usdc, rate, bridgeBps) >= fiat) break;
    const fee = senderFeeFor(usdc * survival);
    usdc = roundUpTo((fiat / rate + fee) / survival, USDC_DECIMALS);
  }
  return usdc;
}

/** The corridor's minimum fiat input, derived from MIN_USDC_AMOUNT. */
export function minFiatFor(
  currency: string,
  rate: number,
  bridgeBps: number,
): number {
  if (!isPositiveFinite(rate)) return 0;
  const raw = usdcToFiat(MIN_USDC_AMOUNT, rate, bridgeBps);
  if (raw <= 0) return 0;
  const step =
    FIAT_MIN_STEP[String(currency ?? "").toUpperCase()] ?? DEFAULT_FIAT_MIN_STEP;
  return Math.ceil(raw / step) * step;
}

export interface SolveUsdcResult {
  usdc: number;
  rate: number;
  iterations: number;
  converged: boolean;
}

/**
 * Resolve the USDC needed for a target fiat amount when the rate depends on the
 * amount.
 *
 * The market book is tiered — `selectTopProviders` picks a band by
 * `min <= amount <= max`, and one provider publishes several bands at different
 * rates. So a first-pass estimate can land in a different band than the rate
 * that produced it, and a single division would quote a rate nobody will honour.
 *
 * Iterate to a fixed point instead: solve, re-price at the candidate amount,
 * repeat until the rate stops moving. Each step is closed-form because the CCTP
 * fee is purely proportional, so this converges in two or three passes.
 *
 * `converged: false` means the amount sits on a band boundary the iteration
 * oscillates across. That is not an error — callers should quote with the
 * returned rate and re-run the forward conversion, which stays truthful either
 * way.
 */
export function solveUsdcForFiat(
  fiat: number,
  opts: {
    resolveRate: (usdc: number) => number;
    bridgeBps: number;
    maxIterations?: number;
  },
): SolveUsdcResult {
  const empty: SolveUsdcResult = {
    usdc: 0,
    rate: 0,
    iterations: 0,
    converged: false,
  };
  if (!isPositiveFinite(fiat)) return empty;

  const maxIterations = Math.max(1, opts.maxIterations ?? 4);

  // Seed with the rate at the corridor's smallest sensible amount; any band is
  // a better starting point than none.
  let rate = opts.resolveRate(MIN_USDC_AMOUNT);
  if (!isPositiveFinite(rate)) return empty;

  let usdc = fiatToUsdc(fiat, rate, opts.bridgeBps);
  let iterations = 1;
  let converged = false;

  for (; iterations <= maxIterations; iterations++) {
    const nextRate = opts.resolveRate(usdc);
    // No band covers this amount — keep the last workable rate rather than
    // collapsing to zero.
    if (!isPositiveFinite(nextRate)) {
      converged = true;
      break;
    }
    if (nextRate === rate) {
      converged = true;
      break;
    }
    rate = nextRate;
    usdc = fiatToUsdc(fiat, rate, opts.bridgeBps);
  }

  if (usdc <= 0) return empty;
  return { usdc, rate, iterations, converged };
}
