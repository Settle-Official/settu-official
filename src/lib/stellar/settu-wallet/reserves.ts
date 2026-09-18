// Stellar reserve maths, derived from the sponsor's own ledger state rather
// than a constant someone has to remember to retune as usage grows.

// All arithmetic is in stroops. XLM is 7 decimal places, and in floating point
// 2.51 - 1 is 1.5099999999999998, which silently misjudges a reserve check.
const STROOPS_PER_XLM = 10_000_000;

export const BASE_RESERVE_XLM = 0.5;
const BASE_RESERVE = 5_000_000;

// Covers the sponsor's own fees; tiny, but never zero.
const FEE_HEADROOM = 100_000;

export interface SponsorState {
  balanceXlm: number;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
}

function toStroops(xlm: number): number {
  return Math.round(xlm * STROOPS_PER_XLM);
}

function toXlm(stroops: number): number {
  return stroops / STROOPS_PER_XLM;
}

/**
 * What the ledger requires this account to hold.
 * Entries it sponsors count against it; entries sponsored for it do not.
 */
function minimumStroops(state: SponsorState): number {
  const entries =
    2 + state.subentryCount + state.numSponsoring - state.numSponsored;
  return entries * BASE_RESERVE;
}

export function minimumBalance(state: SponsorState): number {
  return toXlm(minimumStroops(state));
}

/** An account costs two base reserves, each trustline one more. */
export function creationReserveCost(trustlineCount: number): number {
  return toXlm((2 + trustlineCount) * BASE_RESERVE);
}

export function trustlineReserveCost(count = 1): number {
  return toXlm(count * BASE_RESERVE);
}

/** Free balance above everything already committed; negative if underfunded. */
export function spendableXlm(state: SponsorState): number {
  return toXlm(toStroops(state.balanceXlm) - minimumStroops(state));
}

/** True when this sponsorship would still leave the sponsor above its minimum. */
export function canCover(
  state: SponsorState,
  reserveCostXlm: number,
  extraBufferXlm = 0,
): boolean {
  const available = toStroops(state.balanceXlm) - minimumStroops(state);
  const needed =
    toStroops(reserveCostXlm) + FEE_HEADROOM + toStroops(extraBufferXlm);
  return available >= needed;
}

/** How many more wallets this sponsor can fund, for alerting and capacity. */
export function remainingCapacity(
  state: SponsorState,
  trustlineCount = 1,
): number {
  const available = toStroops(state.balanceXlm) - minimumStroops(state);
  const perWallet = toStroops(creationReserveCost(trustlineCount)) + FEE_HEADROOM;
  return Math.max(0, Math.floor(available / perWallet));
}
