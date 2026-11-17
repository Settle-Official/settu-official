/**
 * Pure unit conversions for the admin bridge console. No imports, so the
 * client component can use them without pulling in server modules.
 *
 * Fees are typed as percentages (0.3) but stored as whole basis points (30);
 * 1 bps = 0.01%, so anything past two decimal places isn't a whole bps.
 */

export type Parsed<T> = { ok: true } & T | { ok: false; error: string };

export function percentToBps(input: string): Parsed<{ bps: number }> {
  const s = input.trim();
  const m = /^(\d{1,3})(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, error: "Enter a percentage, e.g. 0.3" };
  const frac = m[2] ?? "";
  if (frac.length > 2) {
    return {
      ok: false,
      error: "Fees must be whole basis points: at most two decimal places (0.01% = 1 bps).",
    };
  }
  return { ok: true, bps: Number(m[1]) * 100 + Number(frac.padEnd(2, "0")) };
}

export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** "1.5" with 6 decimals → 1500000n. Rejects more decimals than the unit has. */
export function parseAtomic(input: string, decimals: number): Parsed<{ value: bigint }> {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!m) return { ok: false, error: "Enter a non-negative number." };
  const frac = m[2] ?? "";
  if (frac.length > decimals) {
    return { ok: false, error: `At most ${decimals} decimal places.` };
  }
  return { ok: true, value: BigInt(m[1] + frac.padEnd(decimals, "0")) };
}

/** 1500000 with 6 decimals → "1.5". */
export function formatAtomic(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) return atomic;
  const padded = atomic.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * Decimals of each on-chain limit, by chain family. maxNetworkFee is USDC in
 * the contract's own units (Stellar settu-bridge uses 7-dp USDC, Ruling J);
 * maxNativeFee is wei (18) or stroops (7).
 */
export function limitDecimals(
  family: "evm" | "stellar" | "solana",
  limit: "maxNetworkFee" | "maxNativeFee",
): number {
  if (limit === "maxNetworkFee") return family === "stellar" ? 7 : 6;
  if (family === "stellar") return 7;
  if (family === "solana") return 9;
  return 18;
}
