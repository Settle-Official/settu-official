/**
 * Quote math for the user bridge. Exact bigint arithmetic, no floats on
 * amounts. All *Atomic values are in the 6-decimal CCTP unit; Stellar source
 * amounts (7 decimals) are rounded DOWN to 6 decimals before any fee math.
 *
 * Guarantee: receiveAtomic is what the screen shows; on Fast the actual
 * amount is >= receiveAtomic because fastFeeMaxAtomic is a ceiling cap.
 */

import { computeAtomicFee } from "../cctp/iris-client";
import { BRIDGE_CHAINS, type BridgeChainKey } from "./chains";

export type Speed = "fast" | "standard";

export interface Breakdown {
  sendAtomic: bigint;
  settuFeeAtomic: bigint;
  fastFeeMaxAtomic: bigint;
  networkFeeAtomic: bigint;
  totalFeeAtomic: bigint;
  burnAtomic: bigint;
  receiveAtomic: bigint;
  receiveIsMinimum: boolean;
  adjustedAmount?: string;
}

export interface BreakdownInput {
  source: BridgeChainKey;
  dest: BridgeChainKey;
  amount: string;
  speed: Speed;
  feeBps: number;
  fastFeeBps: number;
  networkFeeAtomic: bigint;
}

const CCTP_DECIMALS = 6;

function tooSmall(): { error: string } {
  return { error: "Amount is too small to cover the fees." };
}

/** Ceiling of amount * bps / 10_000, bps allowed fractional (6 digits). */
function ceilBps(bps: number, amount: bigint): bigint {
  if (!Number.isFinite(bps) || bps <= 0) return BigInt(0);
  const scaled = BigInt(Math.round(bps * 1_000_000));
  const den = BigInt(10_000) * BigInt(1_000_000);
  return (amount * scaled + den - BigInt(1)) / den;
}

export function computeBreakdown(
  input: BreakdownInput,
): Breakdown | { error: string } {
  const { source, amount, speed, feeBps, fastFeeBps, networkFeeAtomic } = input;
  const decimals = BRIDGE_CHAINS[source].usdcDecimals;

  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!m) return { error: "Enter a valid amount." };
  const whole = m[1];
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    return { error: `Too many decimal places (max ${decimals}).` };
  }

  // Truncate (round down) to the 6-decimal CCTP unit.
  const kept = frac.slice(0, CCTP_DECIMALS);
  const sendAtomic = BigInt(whole + kept.padEnd(CCTP_DECIMALS, "0"));
  if (sendAtomic <= BigInt(0)) return { error: "Enter an amount greater than zero." };

  let adjustedAmount: string | undefined;
  if (frac.length > kept.length) {
    adjustedAmount = kept.length > 0 ? `${whole}.${kept}` : whole;
  }

  const settuFeeAtomic = ceilBps(feeBps, sendAtomic);
  const totalFeeAtomic = settuFeeAtomic + networkFeeAtomic;
  const burnAtomic = sendAtomic - totalFeeAtomic;
  if (burnAtomic <= BigInt(0)) return tooSmall();

  const fastFeeMaxAtomic =
    speed === "fast" ? computeAtomicFee(fastFeeBps, burnAtomic) : BigInt(0);
  const receiveAtomic = burnAtomic - fastFeeMaxAtomic;
  if (receiveAtomic <= BigInt(0)) return tooSmall();

  const result: Breakdown = {
    sendAtomic,
    settuFeeAtomic,
    fastFeeMaxAtomic,
    networkFeeAtomic,
    totalFeeAtomic,
    burnAtomic,
    receiveAtomic,
    receiveIsMinimum: speed === "fast",
  };
  if (adjustedAmount !== undefined) result.adjustedAmount = adjustedAmount;
  return result;
}
