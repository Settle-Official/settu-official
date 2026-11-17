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
  /** Fee line shown to the user: ceil(send * feeBps / 10000). */
  settuFeeShownAtomic: bigint;
  /** What the contract actually sends to Settu: shown minus Circle's Fast fee cap. */
  settuFeeAtomic: bigint;
  fastFeeMaxAtomic: bigint;
  /** USDC network fee (usdc mode only, else 0). */
  networkFeeAtomic: bigint;
  /** Source-chain native network fee (native mode only, else 0). */
  nativeFeeAtomic: bigint;
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
  networkFeeMode: "usdc" | "native";
  /** USDC atomic; used in usdc mode. */
  networkFeeAtomic: bigint;
  /** Source native units; used in native mode. */
  nativeFeeAtomic: bigint;
}

export type BreakdownError = { error: string; code?: "fast_unavailable" };

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
): Breakdown | BreakdownError {
  const { source, amount, speed, feeBps, fastFeeBps, networkFeeMode } = input;
  if (input.networkFeeAtomic < BigInt(0) || input.nativeFeeAtomic < BigInt(0)) {
    return { error: "Network fee cannot be negative." };
  }
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
  const dropped = frac.slice(CCTP_DECIMALS);
  const sendAtomic = BigInt(whole + kept.padEnd(CCTP_DECIMALS, "0"));
  if (sendAtomic <= BigInt(0)) return { error: "Enter an amount greater than zero." };

  let adjustedAmount: string | undefined;
  if (/[1-9]/.test(dropped)) {
    adjustedAmount = kept.length > 0 ? `${whole}.${kept}` : whole;
  }

  const networkFeeAtomic =
    networkFeeMode === "usdc" ? input.networkFeeAtomic : BigInt(0);
  const nativeFeeAtomic =
    networkFeeMode === "native" ? input.nativeFeeAtomic : BigInt(0);

  const settuFeeShownAtomic = ceilBps(feeBps, sendAtomic);
  // On sendAtomic (an upper bound on the burn) so maxFee is never below Circle's minimum.
  const fastFeeMaxAtomic =
    speed === "fast" ? computeAtomicFee(fastFeeBps, sendAtomic) : BigInt(0);
  if (fastFeeMaxAtomic > settuFeeShownAtomic) {
    return {
      error: "Fast transfer is unavailable for this amount.",
      code: "fast_unavailable",
    };
  }
  const settuFeeAtomic = settuFeeShownAtomic - fastFeeMaxAtomic;
  const burnAtomic = sendAtomic - settuFeeAtomic - networkFeeAtomic;
  const receiveAtomic = sendAtomic - settuFeeShownAtomic - networkFeeAtomic;
  if (receiveAtomic <= BigInt(0) || burnAtomic <= BigInt(0)) return tooSmall();

  const result: Breakdown = {
    sendAtomic,
    settuFeeShownAtomic,
    settuFeeAtomic,
    fastFeeMaxAtomic,
    networkFeeAtomic,
    nativeFeeAtomic,
    burnAtomic,
    receiveAtomic,
    receiveIsMinimum: speed === "fast",
  };
  if (adjustedAmount !== undefined) result.adjustedAmount = adjustedAmount;
  return result;
}
